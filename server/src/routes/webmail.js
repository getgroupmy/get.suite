import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { q, FILES_DIR } from '../db.js';
import { str, bad, notFound, HttpError } from '../util.js';
import { roleFor } from '../access.js';
import { mailEnabled } from '../mail/config.js';
import { imapFor, withFolder, smtpFor } from '../mail/imap.js';

const PAGE = 50;
const MAX_SEND_BYTES = 25 * 1024 * 1024;
const ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const addr = (a) => (a ? { name: a.name || '', address: (a.address || '').toLowerCase() } : null);
const addrList = (field) => (field?.value || []).flatMap((a) => (a.group ? a.group : [a])).map(addr);

/** Addresses this user may send as: their own, plus aliases they belong to. */
function identities(user) {
  const out = [{ address: user.username, name: user.name }];
  for (const a of q('SELECT address, targets FROM aliases WHERE org_id = ?').all(user.org_id)) {
    if (a.targets.split(',').includes(user.username)) out.push({ address: a.address, name: user.name });
  }
  return out;
}

function parseRecipients(value, label) {
  const list = addressparser(String(value || ''), { flatten: true })
    .map((a) => ({ name: a.name || '', address: (a.address || '').trim().toLowerCase() }))
    .filter((a) => a.address);
  for (const a of list) if (!EMAIL_RE.test(a.address)) throw bad(`${label}: “${a.address}” is not a valid email address`);
  return list;
}

async function specialFolder(client, use) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === use)?.path || null;
}

function uidList(v) {
  const arr = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!arr.length) throw bad('No messages selected');
  return arr;
}

export default function webmailRoutes() {
  const r = Router();

  r.get('/status', (req, res) => res.json({ enabled: mailEnabled(), address: req.user.username, identities: identities(req.user) }));

  r.use((req, res, next) => (mailEnabled() ? next() : next(new HttpError(503, 'Email is not set up on this server'))));

  r.get('/folders', async (req, res) => {
    const client = await imapFor(req.user);
    const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
    const rank = (b) => (b.specialUse ? ORDER.indexOf(b.specialUse) : b.path === 'INBOX' ? 0 : 99);
    res.json(boxes.filter((b) => !b.flags?.has('\\Noselect'))
      .map((b) => ({ path: b.path, name: b.path === 'INBOX' ? 'Inbox' : b.name, specialUse: b.path === 'INBOX' ? '\\Inbox' : b.specialUse || null,
        messages: b.status?.messages ?? 0, unseen: b.status?.unseen ?? 0 }))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
  });

  r.get('/messages', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const page = Math.max(1, Number(req.query.page) || 1);
    const term = String(req.query.q || '').trim();
    const out = await withFolder(req.user, folder, async (client) => {
      const total = client.mailbox.exists;
      let range, uidMode = false, count = total;
      if (term) {
        const uids = (await client.search({ or: [{ subject: term }, { from: term }, { to: term }, { body: term }] }, { uid: true })) || [];
        uids.sort((a, b) => b - a);
        count = uids.length;
        const slice = uids.slice((page - 1) * PAGE, page * PAGE);
        if (!slice.length) return { total: count, page, messages: [] };
        range = slice.join(',');
        uidMode = true;
      } else {
        const end = total - (page - 1) * PAGE;
        if (end < 1) return { total, page, messages: [] };
        range = `${Math.max(1, end - PAGE + 1)}:${end}`;
      }
      const messages = [];
      for await (const m of client.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, size: true }, { uid: uidMode })) {
        const env = m.envelope || {};
        messages.push({
          uid: m.uid,
          subject: env.subject || '',
          from: addr(env.from?.[0]),
          to: (env.to || []).map(addr),
          date: (env.date || m.internalDate)?.valueOf?.() ?? null,
          seen: m.flags.has('\\Seen'),
          flagged: m.flags.has('\\Flagged'),
          answered: m.flags.has('\\Answered'),
          attachment: hasAttachment(m.bodyStructure),
          size: m.size,
        });
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { total: count, page, pageSize: PAGE, messages };
    });
    res.json(out);
  });

  async function loadMessage(user, folder, uid, markSeen) {
    return withFolder(user, folder, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg) throw notFound('Message not found');
      if (markSeen && !msg.flags.has('\\Seen')) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      return { parsed: await simpleParser(msg.source), flags: msg.flags };
    });
  }

  r.get('/messages/:uid', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const { parsed: p, flags } = await loadMessage(req.user, folder, Number(req.params.uid), true);
    res.json({
      uid: Number(req.params.uid), folder,
      subject: p.subject || '', date: p.date?.valueOf() ?? null,
      from: addrList(p.from)[0] || null, to: addrList(p.to), cc: addrList(p.cc), replyTo: addrList(p.replyTo),
      messageId: p.messageId || null, references: [].concat(p.references || []),
      html: p.html || null, text: p.text || '', textAsHtml: p.textAsHtml || '',
      flagged: flags.has('\\Flagged'),
      spam: /yes/i.test(String(p.headers.get('x-spam') || '')),
      attachments: p.attachments.map((a, i) => ({ index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size, related: !!a.related }))
        .filter((a) => !a.related),
    });
  });

  r.get('/messages/:uid/attachments/:index', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.query.folder || 'INBOX'), Number(req.params.uid), false);
    const a = parsed.attachments[Number(req.params.index)];
    if (!a) throw notFound('Attachment not found');
    // Always download (never render attacker-supplied content on our origin).
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(a.content);
  });

  r.post('/messages/flags', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    await withFolder(req.user, folder, async (client) => {
      for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']]) {
        if (req.body[key] === true) await client.messageFlagsAdd(uids, [flag], { uid: true });
        if (req.body[key] === false) await client.messageFlagsRemove(uids, [flag], { uid: true });
      }
    });
    res.json({ ok: true });
  });

  // Move to another folder; `to` may be a path or a special folder: inbox, archive, junk, trash.
  r.post('/messages/move', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const client = await imapFor(req.user);
    const special = { inbox: 'INBOX', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }[req.body.to];
    const target = special === 'INBOX' ? 'INBOX' : special ? await specialFolder(client, special) : str(req.body.to, { required: true, name: 'to' });
    if (!target) throw bad('Target folder not found');
    if (target === folder) return res.json({ ok: true });
    await withFolder(req.user, folder, (c) => c.messageMove(uids, target, { uid: true }));
    res.json({ ok: true });
  });

  // Delete: move to Trash, or delete permanently when already in Trash (or Junk).
  r.post('/messages/delete', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const client = await imapFor(req.user);
    const trash = await specialFolder(client, '\\Trash');
    const junk = await specialFolder(client, '\\Junk');
    if (!trash || folder === trash || folder === junk) await withFolder(req.user, folder, (c) => c.messageDelete(uids, { uid: true }));
    else await withFolder(req.user, folder, (c) => c.messageMove(uids, trash, { uid: true }));
    res.json({ ok: true });
  });

  r.post('/send', async (req, res) => {
    const b = req.body;
    const to = parseRecipients(b.to, 'To');
    const cc = parseRecipients(b.cc, 'Cc');
    const bcc = parseRecipients(b.bcc, 'Bcc');
    const all = [...to, ...cc, ...bcc];
    if (!all.length) throw bad('Add at least one recipient');
    if (all.length > 100) throw bad('At most 100 recipients per message');
    const from = identities(req.user).find((i) => i.address === String(b.from || req.user.username).toLowerCase());
    if (!from) throw bad('You cannot send from that address');

    // Attachments: files from Drive the sender can open.
    let total = 0;
    const attachments = [];
    for (const id of Array.isArray(b.attachments) ? b.attachments : []) {
      const f = q("SELECT id, name, mime, size, storage, kind FROM files WHERE id = ?").get(id);
      if (!f || f.kind !== 'file' || !roleFor(f.id, req.user.id)) throw bad('An attachment is not available');
      total += f.size;
      attachments.push({ filename: f.name, contentType: f.mime || 'application/octet-stream', path: path.join(FILES_DIR, f.storage) });
    }
    if (total > MAX_SEND_BYTES) throw bad('Attachments are larger than 25 MB in total');

    const mail = {
      from: { name: from.name, address: from.address },
      to, cc, bcc,
      subject: str(b.subject, { max: 998, name: 'Subject' }) || '',
      text: typeof b.text === 'string' ? b.text : '',
      ...(typeof b.html === 'string' && b.html && { html: b.html }),
      ...(b.inReplyTo && { inReplyTo: String(b.inReplyTo), references: [].concat(b.references || [], b.inReplyTo).map(String).slice(-20) }),
      attachments,
    };
    const raw = await new MailComposer(mail).compile().build();
    const envelope = { from: from.address, to: all.map((a) => a.address) };
    try {
      await smtpFor(req.user).sendMail({ envelope, raw });
    } catch (e) {
      throw new HttpError(e.responseCode && e.responseCode < 500 ? 503 : 400, `Sending failed: ${e.response || e.message}`);
    }

    // Keep a copy in Sent, and mark the original as answered.
    const client = await imapFor(req.user);
    const sent = await specialFolder(client, '\\Sent');
    if (sent) await client.append(sent, raw, ['\\Seen']).catch(() => {});
    if (b.replyTo?.folder && b.replyTo?.uid) {
      await withFolder(req.user, String(b.replyTo.folder), (c) => c.messageFlagsAdd(String(Number(b.replyTo.uid)), ['\\Answered'], { uid: true })).catch(() => {});
    }
    res.json({ ok: true, recipients: all.length });
  });

  return r;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}
