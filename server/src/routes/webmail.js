import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { q, FILES_DIR } from '../db.js';
import { str, bad, notFound, HttpError } from '../util.js';
import { roleFor } from '../access.js';
import { mailEnabled, scheduleMailConfig } from '../mail/config.js';
import { withClient, withFolder, smtpFor } from '../mail/imap.js';
import { normalizeRules } from '../mail/sieve.js';

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

const specialOf = (user, use) => withClient(user, (c) => specialFolder(c, use));

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

  r.get('/status', (req, res) => res.json({
    enabled: mailEnabled(), address: req.user.username, identities: identities(req.user), vacation: vacationOf(req.user.id),
  }));

  r.use((req, res, next) => (mailEnabled() ? next() : next(new HttpError(503, 'Email is not set up on this server'))));

  // ---- vacation auto-reply ----
  r.get('/vacation', (req, res) => res.json(vacationOf(req.user.id)));

  r.put('/vacation', (req, res) => {
    const b = req.body;
    const date = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`${label} must be a date`);
      return v;
    };
    const start = date(b.start_date, 'First day');
    const end = date(b.end_date, 'Last day');
    if (start && end && end < start) throw bad('The last day is before the first day');
    const subject = str(b.subject, { max: 200, name: 'Subject' }) || 'Out of office';
    const body = typeof b.body === 'string' ? b.body.slice(0, 5000) : '';
    if (b.enabled && !body.trim()) throw bad('Write the message people should receive');
    q(`INSERT INTO vacations (user_id, enabled, subject, body, start_date, end_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, subject = excluded.subject, body = excluded.body,
         start_date = excluded.start_date, end_date = excluded.end_date, updated_at = excluded.updated_at`)
      .run(req.user.id, b.enabled ? 1 : 0, subject, body, start, end, Date.now());
    scheduleMailConfig();
    res.json(vacationOf(req.user.id));
  });

  // ---- filter rules (run by the mail server at delivery, see mail/sieve.js) ----
  r.get('/rules', (req, res) => {
    const row = q('SELECT rules FROM mail_rules WHERE user_id = ?').get(req.user.id);
    res.json(row ? JSON.parse(row.rules) : []);
  });

  r.put('/rules', (req, res) => {
    const rules = normalizeRules(req.body.rules);
    q(`INSERT INTO mail_rules (user_id, rules, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`)
      .run(req.user.id, JSON.stringify(rules), Date.now());
    scheduleMailConfig();
    res.json(rules);
  });

  // ---- folders: create, rename, delete (built-in folders are protected) ----
  const cleanFolderName = (v) => {
    const name = str(v, { required: true, name: 'Folder name', max: 100 }).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (!name || /[\x00-\x1f*%]/.test(name) || name.toUpperCase() === 'INBOX') throw bad('That folder name is not allowed');
    return name;
  };
  const isProtected = (b) => b.path.toUpperCase() === 'INBOX' || !!b.specialUse;
  const inTree = (p, root) => p === root || p.startsWith(`${root}/`);

  r.post('/folders', async (req, res) => {
    const name = cleanFolderName(req.body.name);
    const exists = (await withClient(req.user, (c) => c.list())).some((b) => b.path.toLowerCase() === name.toLowerCase());
    if (exists) throw bad('A folder with that name already exists');
    await withClient(req.user, async (c) => { await c.mailboxCreate(name); await c.mailboxSubscribe(name).catch(() => {}); });
    res.status(201).json({ path: name });
  });

  // Rename (subfolders move with it); filters that file mail there are updated.
  r.patch('/folders', async (req, res) => {
    const from = String(req.body.path || '');
    const to = cleanFolderName(req.body.newPath);
    const boxes = await withClient(req.user, (c) => c.list());
    const box = boxes.find((b) => b.path === from);
    if (!box) throw notFound('Folder not found');
    if (isProtected(box)) throw bad('Built-in folders cannot be renamed');
    if (to === from) return res.json({ path: to, updatedFilters: 0 });
    if (inTree(to, from)) throw bad('A folder cannot be moved inside itself');
    if (boxes.some((b) => b.path.toLowerCase() === to.toLowerCase())) throw bad('A folder with that name already exists');
    await withClient(req.user, async (c) => {
      // Leave the folder first: renaming the selected mailbox would confuse the pooled connection.
      (await c.getMailboxLock('INBOX')).release();
      await c.mailboxRename(from, to);
      const renamed = (await c.list()).filter((b) => inTree(b.path, to));
      for (const b of renamed) await c.mailboxSubscribe(b.path).catch(() => {});
    });
    const updatedFilters = updateRules(req.user.id, (rule) => {
      const m = rule.actions.moveTo;
      if (!m || !inTree(m, from)) return false;
      rule.actions.moveTo = to + m.slice(from.length);
      return true;
    });
    res.json({ path: to, updatedFilters });
  });

  // Delete: messages (including subfolders') go to Trash first; filters that filed mail there are switched off.
  r.delete('/folders', async (req, res) => {
    const target = String(req.query.path || '');
    const boxes = await withClient(req.user, (c) => c.list());
    const box = boxes.find((b) => b.path === target);
    if (!box) throw notFound('Folder not found');
    if (isProtected(box)) throw bad('Built-in folders cannot be deleted');
    const trash = boxes.find((b) => b.specialUse === '\\Trash')?.path;
    const victims = boxes.filter((b) => inTree(b.path, target)).sort((a, b) => b.path.length - a.path.length);
    let moved = 0, deleted = 0;
    for (const v of victims) {
      // A parent that only exists as part of a path ("Clients" of "Clients/Acme") holds no mail
      // and disappears by itself once its subfolders are gone.
      const placeholder = v.flags?.has('\\Noselect') || v.flags?.has('\\NonExistent');
      if (placeholder) continue;
      if (trash) {
        moved += await withFolder(req.user, v.path, async (c) => {
          const n = c.mailbox.exists;
          if (n) await c.messageMove('1:*', trash);
          return n;
        });
      }
      await withClient(req.user, async (c) => {
        (await c.getMailboxLock('INBOX')).release();
        await c.mailboxUnsubscribe(v.path).catch(() => {});
        await c.mailboxDelete(v.path);
      });
      deleted++;
    }
    const disabledFilters = updateRules(req.user.id, (rule) => {
      if (!rule.enabled || !rule.actions.moveTo || !inTree(rule.actions.moveTo, target)) return false;
      rule.enabled = false;
      return true;
    });
    res.json({ ok: true, movedToTrash: moved, deletedFolders: deleted, disabledFilters });
  });

  /** Apply fn to each of a user's rules; save and rebuild the Sieve script if any changed. */
  function updateRules(userId, fn) {
    const row = q('SELECT rules FROM mail_rules WHERE user_id = ?').get(userId);
    if (!row) return 0;
    const rules = JSON.parse(row.rules);
    const changed = rules.filter((rule) => fn(rule)).length;
    if (changed) {
      q('UPDATE mail_rules SET rules = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(rules), Date.now(), userId);
      scheduleMailConfig();
    }
    return changed;
  }

  // ---- signatures: one per sending address ----
  r.get('/signatures', (req, res) => {
    res.json(identities(req.user).map((i) => ({ address: i.address, ...signatureOf(req.user.id, i.address) })));
  });
  r.put('/signatures/:address', (req, res) => {
    const address = String(req.params.address).toLowerCase();
    if (!identities(req.user).some((i) => i.address === address)) throw bad('You cannot send from that address');
    const html = typeof req.body.html === 'string' ? req.body.html : '';
    if (html.length > 20000) throw bad('The signature is too long');
    q(`INSERT INTO identity_signatures (user_id, address, html, on_new, on_reply, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET html = excluded.html, on_new = excluded.on_new, on_reply = excluded.on_reply, updated_at = excluded.updated_at`)
      .run(req.user.id, address, html, req.body.on_new === false ? 0 : 1, req.body.on_reply === false ? 0 : 1, Date.now());
    res.json({ address, ...signatureOf(req.user.id, address) });
  });

  r.get('/folders', async (req, res) => {
    const boxes = await withClient(req.user, (c) => c.list({ statusQuery: { messages: true, unseen: true } }));
    const rank = (b) => (b.specialUse ? ORDER.indexOf(b.specialUse) : b.path === 'INBOX' ? 0 : 99);
    res.json(boxes.filter((b) => !b.flags?.has('\\Noselect'))
      // Nested folders show their full path ("Partners / Globex") so it's clear where they live.
      .map((b) => ({ path: b.path, name: b.path === 'INBOX' ? 'Inbox' : b.path.split(b.delimiter || '/').join(' / '), specialUse: b.path === 'INBOX' ? '\\Inbox' : b.specialUse || null,
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
    const special = { inbox: 'INBOX', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }[req.body.to];
    const target = special === 'INBOX' ? 'INBOX' : special ? await specialOf(req.user, special) : str(req.body.to, { required: true, name: 'to' });
    if (!target) throw bad('Target folder not found');
    if (target === folder) return res.json({ ok: true });
    await withFolder(req.user, folder, (c) => c.messageMove(uids, target, { uid: true }));
    res.json({ ok: true });
  });

  // Delete: move to Trash, or delete permanently when already in Trash (or Junk).
  r.post('/messages/delete', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const trash = await specialOf(req.user, '\\Trash');
    const junk = await specialOf(req.user, '\\Junk');
    if (!trash || folder === trash || folder === junk) await withFolder(req.user, folder, (c) => c.messageDelete(uids, { uid: true }));
    else await withFolder(req.user, folder, (c) => c.messageMove(uids, trash, { uid: true }));
    res.json({ ok: true });
  });

  // ---- drafts (stored in the IMAP Drafts folder, so phones and Outlook see them too) ----
  r.post('/drafts', async (req, res) => {
    const b = req.body;
    const folder = await specialOf(req.user, '\\Drafts');
    if (!folder) throw bad('No Drafts folder');
    const from = identities(req.user).find((i) => i.address === String(b.from || '').toLowerCase()) || identities(req.user)[0];
    const meta = {
      from: from.address, to: String(b.to || ''), cc: String(b.cc || ''), bcc: String(b.bcc || ''),
      attachments: (Array.isArray(b.attachments) ? b.attachments : []).map(String).slice(0, 50),
      inReplyTo: b.inReplyTo ? String(b.inReplyTo) : null, references: [].concat(b.references || []).map(String).slice(-20),
      replyTo: b.replyTo?.folder && b.replyTo?.uid ? { folder: String(b.replyTo.folder), uid: Number(b.replyTo.uid) } : null,
    };
    // Half-typed addresses are fine in a draft: keep exactly what was typed in our own header.
    const lenient = (v) => addressparser(v, { flatten: true }).filter((a) => EMAIL_RE.test(a.address || '')).map((a) => ({ name: a.name || '', address: a.address }));
    const raw = await new MailComposer({
      from: { name: from.name, address: from.address },
      to: lenient(meta.to), cc: lenient(meta.cc),
      subject: String(b.subject || '').slice(0, 998),
      text: typeof b.text === 'string' ? b.text : '',
      ...(typeof b.html === 'string' && b.html && { html: b.html.slice(0, 2_000_000) }),
      ...(meta.inReplyTo && { inReplyTo: meta.inReplyTo, references: meta.references }),
      headers: { 'X-Workspace-Draft': chunk(Buffer.from(JSON.stringify(meta)).toString('base64')) },
    }).compile().build();
    const appended = await withClient(req.user, (c) => c.append(folder, raw, ['\\Draft', '\\Seen']));
    if (b.uid) await deleteDraft(req.user, folder, Number(b.uid));
    res.json({ uid: appended?.uid ?? null, savedAt: Date.now() });
  });

  r.get('/drafts/:uid', async (req, res) => {
    const folder = await specialOf(req.user, '\\Drafts');
    const { parsed: p } = await loadMessage(req.user, folder, Number(req.params.uid), false);
    let meta = null;
    try {
      const h = p.headers.get('x-workspace-draft');
      const joined = [].concat(h || []).map(String).sort().map((x) => x.replace(/^\d+:/, '')).join('');
      if (joined) meta = JSON.parse(Buffer.from(joined, 'base64').toString('utf8'));
    } catch { meta = null; }
    const fmt = (list) => addrList(list).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
    const files = (meta?.attachments || []).map((id) => q("SELECT id, name, size, kind FROM files WHERE id = ?").get(id))
      .filter((f) => f && f.kind === 'file' && roleFor(f.id, req.user.id));
    res.json({
      uid: Number(req.params.uid),
      from: meta?.from || addrList(p.from)[0]?.address || req.user.username,
      to: meta?.to ?? fmt(p.to), cc: meta?.cc ?? fmt(p.cc), bcc: meta?.bcc ?? fmt(p.bcc),
      subject: p.subject || '', text: p.text || '', html: p.html || null,
      attachments: files,
      inReplyTo: meta?.inReplyTo || p.inReplyTo || null, references: meta?.references || [].concat(p.references || []),
      replyTo: meta?.replyTo || null,
    });
  });

  r.delete('/drafts/:uid', async (req, res) => {
    const folder = await specialOf(req.user, '\\Drafts');
    await deleteDraft(req.user, folder, Number(req.params.uid));
    res.json({ ok: true });
  });

  async function deleteDraft(user, folder, uid) {
    if (!folder || !Number.isInteger(uid) || uid < 1) return;
    await withFolder(user, folder, async (c) => {
      const m = await c.fetchOne(String(uid), { flags: true }, { uid: true });
      if (m && m.flags.has('\\Draft')) await c.messageDelete(String(uid), { uid: true });
    });
  }

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
    // Inline images: <img src="/api/files/<id>/raw"> (pictures inserted from Drive or pasted) are
    // embedded in the message as cid: parts, so recipients see them without access to this server.
    let html = typeof b.html === 'string' && b.html ? b.html : null;
    if (html) {
      const embedded = new Map();
      html = html.replace(/(<img\b[^>]*?\bsrc=")\/api\/files\/([0-9a-f-]{36})\/raw(?:\?[^"]*)?(")/gi, (m, pre, id, post) => {
        if (!embedded.has(id)) {
          const f = q("SELECT id, name, mime, size, storage, kind FROM files WHERE id = ?").get(id);
          if (!f || f.kind !== 'file' || !roleFor(f.id, req.user.id)) throw bad('A picture in the message is not available');
          if (!/^image\/(png|jpeg|gif|webp)$/.test(f.mime || '')) throw bad(`“${f.name}” is not a picture that can be shown in email`);
          total += f.size;
          embedded.set(id, { filename: f.name, contentType: f.mime, path: path.join(FILES_DIR, f.storage), cid: `img-${id}@workspace`, contentDisposition: 'inline' });
        }
        return `${pre}cid:img-${id}@workspace${post}`;
      });
      attachments.push(...embedded.values());
    }
    if (total > MAX_SEND_BYTES) throw bad('Attachments and pictures are larger than 25 MB in total');

    const mail = {
      from: { name: from.name, address: from.address },
      to, cc, bcc,
      subject: str(b.subject, { max: 998, name: 'Subject' }) || '',
      text: typeof b.text === 'string' ? b.text : '',
      ...(html && { html }),
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
    const sent = await specialOf(req.user, '\\Sent').catch(() => null);
    if (sent) await withClient(req.user, (c) => c.append(sent, raw, ['\\Seen'])).catch(() => {});
    if (b.draftUid) await deleteDraft(req.user, await specialOf(req.user, '\\Drafts').catch(() => null), Number(b.draftUid)).catch(() => {});
    if (b.replyTo?.folder && b.replyTo?.uid) {
      await withFolder(req.user, String(b.replyTo.folder), (c) => c.messageFlagsAdd(String(Number(b.replyTo.uid)), ['\\Answered'], { uid: true })).catch(() => {});
    }
    res.json({ ok: true, recipients: all.length });
  });

  return r;
}

/** Split a long header value into numbered pieces (RFC 5322 lines must stay under 998 characters). */
function chunk(value, size = 800) {
  const out = [];
  for (let i = 0; i * size < value.length; i++) out.push(`${String(i).padStart(3, '0')}:${value.slice(i * size, (i + 1) * size)}`);
  return out.length ? out : ['000:'];
}

function signatureOf(userId, address) {
  const sg = q('SELECT html, on_new, on_reply FROM identity_signatures WHERE user_id = ? AND address = ?').get(userId, address);
  return sg ? { html: sg.html, on_new: !!sg.on_new, on_reply: !!sg.on_reply } : { html: '', on_new: true, on_reply: true };
}

function vacationOf(userId) {
  const v = q('SELECT enabled, subject, body, start_date, end_date FROM vacations WHERE user_id = ?').get(userId);
  const today = new Date().toISOString().slice(0, 10);
  const out = v ? { ...v, enabled: !!v.enabled } : { enabled: false, subject: 'Out of office', body: '', start_date: null, end_date: null };
  // "active" = replying right now; "scheduled" = on, but the first day is still ahead.
  out.active = out.enabled && (!out.end_date || out.end_date >= today) && (!out.start_date || out.start_date <= today);
  out.scheduled = out.enabled && !!out.start_date && out.start_date > today;
  return out;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}
