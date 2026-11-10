// Signatures: send a document out for signing. Each signer (a colleague, or anyone by email when the
// company allows links for people outside) gets a private link, reads the document as it was sent,
// and signs it by drawing or typing their name. While it's out the document is locked; once everyone
// has signed it stays locked, with a record of who signed, when and from where, and a fingerprint
// (SHA-256) of the text that was signed. Mounted at /api/signatures and /api/public/sign.
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError } from '../util.js';
import { roleFor, atLeast } from '../access.js';
import { canReach } from '../tenancy.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { recordActivity } from '../fileactivity.js';
import { mailEnabled } from '../mail/config.js';
import { smtpFor } from '../mail/imap.js';
import { saveNow } from '../collab.js';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../db.js';
import { typeOf, withSignaturesPage, fillFields, pageCount } from '../pdftools.js';

// A PDF sent for signature: its content is { pdf: <storage of a frozen copy> }, and its hash that of the bytes.
const pdfOf = (content) => { try { const c = JSON.parse(content || '{}'); return c.pdf ? c.pdf : null; } catch { return null; } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Where the people on it open the file: the document, or for a PDF Drive's Signatures. */
const linkTo = (fileId) => (q('SELECT kind FROM files WHERE id = ?').get(fileId)?.kind === 'doc' ? `/docs/${fileId}` : '/drive/signatures');
/** Once everyone has signed a PDF: "… (signed).pdf" beside it, with a Signatures page at the end. */
async function saveSignedPdf(r) {
  const frozen = pdfOf(r.content);
  const f = q('SELECT * FROM files WHERE id = ?').get(r.file_id);
  const by = q('SELECT * FROM users WHERE id = ?').get(r.requested_by);
  if (!frozen || !f || !by) return null;
  const signers = q('SELECT name, email, signed_at, ip, image FROM sign_signers WHERE request_id = ? ORDER BY position').all(r.id);
  let pdf = fs.readFileSync(path.join(FILES_DIR, frozen));
  const fields = r.fields ? JSON.parse(r.fields) : [];
  if (fields.length) pdf = Buffer.from(await fillFields(pdf, fields, Object.fromEntries(signers.map((x) => [x.email.toLowerCase(), x]))));
  const bytes = Buffer.from(await withSignaturesPage(pdf, { title: r.title, hash: r.hash, signers }));
  const { insertFile } = await import('./files.js');
  const storage = uid();
  fs.writeFileSync(path.join(FILES_DIR, storage), bytes);
  const parentId = f.parent_id && atLeast(roleFor(f.parent_id, by.id) || '', 'editor') ? f.parent_id : null;
  const id = insertFile({ owner: by.id, parentId, name: `${f.name.replace(/\.pdf$/i, '')} (signed).pdf`, kind: 'file', mime: 'application/pdf', size: bytes.length, storage });
  q('UPDATE sign_requests SET signed_file_id = ? WHERE id = ?').run(id, r.id);
  sendTo([by.id], { type: 'files-changed', parent_id: parentId });
  return id;
}

q(`CREATE TABLE IF NOT EXISTS sign_requests (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,            -- the document as sent (what's signed)
  hash TEXT NOT NULL,               -- SHA-256 of it
  status TEXT NOT NULL DEFAULT 'pending', -- pending | complete | cancelled | declined
  created_at INTEGER NOT NULL,
  completed_at INTEGER
)`).run();
q(`CREATE TABLE IF NOT EXISTS sign_signers (
  request_id TEXT NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  signed_at INTEGER,
  name TEXT,                        -- the name they signed with
  image TEXT,                       -- their drawn signature (PNG data URL), or null when typed
  ip TEXT,
  PRIMARY KEY (request_id, email)
)`).run();
q('CREATE INDEX IF NOT EXISTS sign_requests_file ON sign_requests(file_id, created_at)').run();
if (!q('PRAGMA table_info(sign_requests)').all().some((c) => c.name === 'reminded_at')) q('ALTER TABLE sign_requests ADD COLUMN reminded_at INTEGER').run();
// A signer who declined: who, why and when (the request stops there).
for (const [col, type] of [['declined_by', 'TEXT'], ['decline_reason', 'TEXT']]) {
  if (!q('PRAGMA table_info(sign_requests)').all().some((c) => c.name === col)) q(`ALTER TABLE sign_requests ADD COLUMN ${col} ${type}`).run();
}
// in_order: signers sign one after another, each asked once the one before has signed.
// A PDF's boxes for each signer: [{ email, page, x, y, w, h, type: 'signature' | 'date' }] (fractions of the page).
if (!q('PRAGMA table_info(sign_requests)').all().some((c) => c.name === 'fields')) q('ALTER TABLE sign_requests ADD COLUMN fields TEXT').run();
if (!q('PRAGMA table_info(sign_requests)').all().some((c) => c.name === 'signed_file_id')) q('ALTER TABLE sign_requests ADD COLUMN signed_file_id TEXT').run();
if (!q('PRAGMA table_info(sign_requests)').all().some((c) => c.name === 'in_order')) q('ALTER TABLE sign_requests ADD COLUMN in_order INTEGER NOT NULL DEFAULT 0').run();

/** Whose turn it is: everyone still to sign, or (in order) just the first of them. */
function turnOf(r) {
  const left = q('SELECT email, user_id, token, position FROM sign_signers WHERE request_id = ? AND signed_at IS NULL ORDER BY position').all(r.id);
  return r.in_order ? left.slice(0, 1) : left;
}
/** Ask someone to sign (a notification for colleagues, and an email), from the person who sent it. */
async function askToSign(from, r, p, base, { reminder = false } = {}) {
  if (p.user_id === from.id) return;
  const link = `${base}/sign/${p.token}`;
  if (p.user_id) bell([p.user_id], { kind: 'share', title: reminder ? `Reminder: ${from.name} is waiting for you to sign “${r.title}”` : `${from.name} asked you to sign “${r.title}”`, body: !reminder && r.message ? r.message.slice(0, 200) : null, link: `/sign/${p.token}`, actor: from.name });
  await mailSigner(from, p.email, reminder ? `Reminder: please sign ${r.title}` : `Please sign: ${r.title}`,
    `${from.name} ${reminder ? 'is still waiting for you to sign' : 'has asked you to sign'} “${r.title}”.${!reminder && r.message ? `\n\n${r.message}` : ''}\n\nRead and sign it here:\n${link}\n\nThis link is just for you.`);
}

const MAX_SIGNERS = 20, MAX_IMAGE = 300 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** A request as the people on the document see it (tokens left out). */
export function describe(r, { forUser = null } = {}) {
  if (!r) return null;
  const signers = q('SELECT email, user_id, signed_at, name, image, ip, token FROM sign_signers WHERE request_id = ? ORDER BY position').all(r.id);
  const by = q('SELECT id, name, username FROM users WHERE id = ?').get(r.requested_by);
  const file = q('SELECT content, storage FROM files WHERE id = ?').get(r.file_id);
  const isPdf = !!pdfOf(r.content);
  const curHash = isPdf ? (file?.storage ? sha(fs.readFileSync(path.join(FILES_DIR, file.storage))) : '') : sha(file?.content || '{}');
  return { id: r.id, file_id: r.file_id, title: r.title, message: r.message, status: r.status, hash: r.hash, created_at: r.created_at, completed_at: r.completed_at, requested_by: by,
    changed_since: curHash !== r.hash, // the document isn't what was signed any more
    pdf: isPdf, signed_file_id: r.signed_file_id || null, boxes: r.fields ? JSON.parse(r.fields).length : 0,
    in_order: !!r.in_order, declined_by: r.declined_by || null, decline_reason: r.decline_reason || null,
    signers: signers.map(({ token, ...s }) => ({ ...s, ...(forUser && s.user_id === forUser && !s.signed_at && r.status === 'pending' && turnOf(r).some((t) => t.token === token) && { my_link: `/sign/${token}` }) })) };
}
/** The finished signatures of a document, for its downloads, if what it says now is what was signed. */
export function signedRecord(fileId) {
  const r = describe(q("SELECT * FROM sign_requests WHERE file_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1").get(fileId));
  return r && !r.changed_since ? r : null;
}
const latestFor = (fileId, userId) => describe(q("SELECT * FROM sign_requests WHERE file_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1").get(fileId), { forUser: userId });
const peopleOf = (r) => [r.requested_by, ...q('SELECT user_id FROM sign_signers WHERE request_id = ? AND user_id IS NOT NULL').all(r.id).map((x) => x.user_id)].filter(Boolean);
const tell = (r) => sendTo(new Set(peopleOf(r)), { type: 'signatures-changed', file_id: r.file_id });

async function mailSigner(from, to, subject, text) {
  if (!mailEnabled()) return;
  try { await smtpFor(from).sendMail({ from: { name: from.name, address: from.username }, to, subject, text }); } catch (e) { console.error('[sign] email:', e.message); }
}

export default function signatureRoutes() {
  const r = Router();

  // Waiting for your signature, and what you've sent.
  r.get('/', (req, res) => {
    const waiting = q(`SELECT r.*, s.token FROM sign_requests r JOIN sign_signers s ON s.request_id = r.id
                       WHERE s.user_id = ? AND s.signed_at IS NULL AND r.status = 'pending' ORDER BY r.created_at DESC`).all(req.user.id)
      .filter((x) => turnOf(x).some((t) => t.token === x.token))
      .map(({ token, ...x }) => ({ ...describe(x), link: `/sign/${token}` }));
    const sent = q("SELECT * FROM sign_requests WHERE requested_by = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 50").all(req.user.id).map((x) => describe(x));
    res.json({ waiting, sent });
  });

  // Remind the people who haven't signed yet (at most once an hour).
  r.post('/:id/remind', async (req, res) => {
    const s = q('SELECT * FROM sign_requests WHERE id = ?').get(req.params.id);
    if (!s) throw notFound('Not found');
    if (s.requested_by !== req.user.id) throw forbidden('Only the person who sent it can send reminders');
    if (s.status !== 'pending') throw bad('It is already finished');
    if (s.reminded_at && now() - s.reminded_at < 3600e3) throw new HttpError(429, 'A reminder was sent less than an hour ago');
    const left = turnOf(s);
    q('UPDATE sign_requests SET reminded_at = ? WHERE id = ?').run(now(), s.id);
    for (const p of left) await askToSign(req.user, s, p, baseUrl(req), { reminder: true });
    res.json({ reminded: left.filter((p) => p.user_id !== req.user.id).length });
  });

  r.get('/file/:fileId', (req, res) => {
    const f = q('SELECT * FROM files WHERE id = ? AND trashed = 0').get(String(req.params.fileId));
    if (!f || !roleFor(f.id, req.user.id)) throw notFound('File not found');
    res.json({ current: latestFor(f.id, req.user.id) });
  });

  // Send it out: { file_id, signers: [emails], message }.
  r.post('/', async (req, res) => {
    const f = q('SELECT * FROM files WHERE id = ? AND trashed = 0').get(String(req.body?.file_id || ''));
    const role = f && roleFor(f.id, req.user.id);
    if (!role) throw notFound('File not found');
    const isPdf = f.kind === 'file' && typeOf(f) === 'pdf' && f.storage;
    if (f.kind !== 'doc' && !isPdf) throw bad('Only documents and PDFs can be sent for signature');
    if (!atLeast(role, 'editor')) throw forbidden('Only people who can edit the document can send it for signature');
    if (q("SELECT 1 FROM sign_requests WHERE file_id = ? AND status = 'pending'").get(f.id)) throw bad('It is already out for signature. Cancel that first.');
    if (f.locked_at) throw new HttpError(423, 'The document is locked. Unlock it before sending it for signature.');
    const emails = [...new Set((Array.isArray(req.body?.signers) ? req.body.signers : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) throw bad('Add at least one signer');
    if (emails.length > MAX_SIGNERS) throw bad(`Up to ${MAX_SIGNERS} signers`);
    const outsideOk = !!q('SELECT allow_links FROM orgs WHERE id = ?').get(req.user.org_id)?.allow_links;
    const people = emails.map((email) => {
      if (!EMAIL.test(email)) throw bad(`“${email}” isn't an email address`);
      const u = q('SELECT id, name, username, org_id FROM users WHERE username = ? COLLATE NOCASE AND disabled = 0').get(email);
      if (u && !canReach(req.user, u.id)) throw bad(`You can't send to ${email}`);
      if (!u && !outsideOk) throw forbidden('Your company has turned off links for people outside it, so only colleagues can sign');
      if (!u && !mailEnabled()) throw bad(`${email} isn't on this server, and email is off, so they couldn't be sent the link`);
      return { email, user: u || null, token: crypto.randomBytes(18).toString('base64url') };
    });
    let content, hash, fields = null;
    if (isPdf) { // a frozen copy of the PDF as sent: what's signed, whatever happens to the file
      const bytes = fs.readFileSync(path.join(FILES_DIR, f.storage));
      // Where each signer signs (optional): boxes on the pages, each for one of the signers.
      const given = Array.isArray(req.body?.fields) ? req.body.fields : [];
      if (given.length > 100) throw bad('At most 100 boxes');
      if (given.length) {
        let pages;
        try { pages = await pageCount(bytes); } catch { throw bad('This PDF couldn’t be read'); }
        const frac = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) throw bad('A box is off the page'); return n; };
        fields = given.map((b) => {
          const email = String(b?.email || '').trim().toLowerCase();
          if (!emails.includes(email)) throw bad(`A box is for ${email || 'nobody'}, who isn’t one of the signers`);
          const page = Math.trunc(Number(b.page));
          if (!(page >= 0 && page < pages)) throw bad(`This PDF has ${pages} pages`);
          const box = { email, page, x: frac(b.x), y: frac(b.y), w: frac(b.w), h: frac(b.h), type: b.type === 'date' ? 'date' : 'signature' };
          if (!(box.w > 0.01 && box.h > 0.005)) throw bad('A box is too small');
          return box;
        });
      }
      const copy = uid();
      fs.writeFileSync(path.join(FILES_DIR, copy), bytes);
      content = JSON.stringify({ pdf: copy });
      hash = sha(bytes);
    } else {
      saveNow(f.id); // what's being edited right now is what gets signed
      content = q('SELECT content FROM files WHERE id = ?').get(f.id).content || '{}';
      hash = sha(content);
    }
    const id = uid(), t = now();
    tx(() => {
      q('INSERT INTO sign_requests (id, file_id, requested_by, title, message, content, hash, created_at, in_order, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, f.id, req.user.id, f.name, str(req.body?.message ?? '', { max: 1000 }) || '', content, hash, t, req.body?.in_order ? 1 : 0, fields?.length ? JSON.stringify(fields) : null);
      people.forEach((p, i) => q('INSERT INTO sign_signers (request_id, email, user_id, token, position) VALUES (?, ?, ?, ?, ?)').run(id, p.email, p.user?.id || null, p.token, i));
      q('UPDATE files SET locked_by = ?, locked_at = ? WHERE id = ?').run(req.user.id, t, f.id);
    });
    recordActivity(f.id, req.user.id, 'lock');
    sendTo(new Set([req.user.id, ...people.map((p) => p.user?.id).filter(Boolean)]), { type: 'file-locked', id: f.id, locked_at: t, by_name: req.user.name });
    const made = q('SELECT * FROM sign_requests WHERE id = ?').get(id);
    for (const p of turnOf(made)) await askToSign(req.user, made, p, baseUrl(req));
    tell(made);
    res.status(201).json(describe(made, { forUser: req.user.id }));
  });

  // Whoever sent it can call it off while it's waiting: the document is unlocked again.
  r.post('/:id/cancel', (req, res) => {
    const s = q('SELECT * FROM sign_requests WHERE id = ?').get(req.params.id);
    if (!s) throw notFound('Not found');
    if (s.requested_by !== req.user.id) throw forbidden('Only the person who sent it can cancel it');
    if (s.status !== 'pending') throw bad('It is already finished');
    tx(() => {
      q("UPDATE sign_requests SET status = 'cancelled', completed_at = ? WHERE id = ?").run(now(), s.id);
      q('UPDATE files SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(s.file_id);
    });
    recordActivity(s.file_id, req.user.id, 'unlock');
    sendTo(new Set(peopleOf(s)), { type: 'file-locked', id: s.file_id, locked_at: null, by_name: req.user.name });
    tell(s);
    res.json({ ok: true });
  });
  return r;
}

/** The signing page (no account needed): the document as sent, and signing it. */
export function publicSignRoutes() {
  const r = Router();
  const find = (token) => {
    const s = q(`SELECT s.*, r.id AS rid, r.title, r.message, r.content, r.hash, r.status, r.fields, r.requested_by, r.file_id, r.in_order, r.declined_by, r.decline_reason, u.name AS by_name
                 FROM sign_signers s JOIN sign_requests r ON r.id = s.request_id LEFT JOIN users u ON u.id = r.requested_by WHERE s.token = ?`).get(String(token));
    if (!s || s.status === 'cancelled') throw notFound('This signing link is no longer valid');
    return s;
  };
  const shown = (s) => ({
    title: s.title, message: s.message, requested_by: s.by_name, status: s.status, hash: s.hash, content: pdfOf(s.content) ? { pdf: true } : JSON.parse(s.content),
    my_boxes: s.fields ? JSON.parse(s.fields).filter((b) => b.email === String(s.email).toLowerCase()).map(({ email, ...b }) => b) : [],
    me: { email: s.email, signed_at: s.signed_at, name: s.name },
    in_order: !!s.in_order, declined_by: s.declined_by || null, decline_reason: s.decline_reason || null,
    waiting_for: s.status === 'pending' && !s.signed_at && !turnOf({ id: s.rid, in_order: s.in_order }).some((t) => t.token === s.token)
      ? (() => { const t = turnOf({ id: s.rid, in_order: s.in_order })[0]; return t ? (q('SELECT name FROM sign_signers WHERE request_id = ? AND email = ?').get(s.rid, t.email)?.name || t.email) : null; })() : null,
    signers: q('SELECT email, name, signed_at FROM sign_signers WHERE request_id = ? ORDER BY position').all(s.rid).map((x) => ({ name: x.name, email: x.email, signed: !!x.signed_at })),
  });
  r.get('/:token', (req, res) => res.json(shown(find(req.params.token))));
  // A PDF as it was sent, for the signing page to show.
  r.get('/:token/pdf', (req, res) => {
    const frozen = pdfOf(find(req.params.token).content);
    if (!frozen) throw notFound('Not a PDF');
    res.type('application/pdf').setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.join(FILES_DIR, frozen));
  });
  // Sign: { name, image (a PNG data URL, or null for a typed signature), agree: true }.
  r.post('/:token', async (req, res) => {
    const s = find(req.params.token);
    if (s.signed_at) throw bad('You have already signed this');
    if (s.status !== 'pending') throw bad('This is no longer waiting for signatures');
    if (!turnOf({ id: s.rid, in_order: s.in_order }).some((t) => t.token === s.token)) throw bad('It isn’t your turn to sign yet');
    if (req.body?.agree !== true) throw bad('Tick the box to agree to sign electronically');
    const name = str(req.body?.name ?? '', { required: true, name: 'Your name', max: 100 });
    let image = req.body?.image ?? null;
    if (image !== null && (typeof image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > MAX_IMAGE)) throw bad('That signature picture can’t be used');
    const t = now();
    let done = false;
    tx(() => {
      q('UPDATE sign_signers SET signed_at = ?, name = ?, image = ?, ip = ? WHERE request_id = ? AND email = ?').run(t, name, image, req.ip || null, s.request_id, s.email);
      done = !q('SELECT 1 FROM sign_signers WHERE request_id = ? AND signed_at IS NULL').get(s.request_id);
      if (done) q("UPDATE sign_requests SET status = 'complete', completed_at = ? WHERE id = ?").run(t, s.request_id);
    });
    let reqRow = q('SELECT * FROM sign_requests WHERE id = ?').get(s.request_id);
    if (done && pdfOf(reqRow.content)) { try { await saveSignedPdf(reqRow); } catch (e) { console.error('[sign] signed PDF:', e.message); } reqRow = q('SELECT * FROM sign_requests WHERE id = ?').get(s.request_id); }
    const requester = s.requested_by && q('SELECT * FROM users WHERE id = ?').get(s.requested_by);
    if (!done && reqRow.in_order && requester) for (const p of turnOf(reqRow)) await askToSign(requester, reqRow, p, baseUrl(req)); // the next one's turn
    if (s.requested_by) {
      bell([s.requested_by], { kind: 'share', title: done ? `Everyone has signed “${s.title}”` : `${name} signed “${s.title}”`, body: null, link: linkTo(s.file_id), actor: name });
      if (done && requester) await mailSigner(requester, requester.username, `Signed by everyone: ${s.title}`, reqRow.signed_file_id
        ? `Everyone has signed “${s.title}”.\n\nThe signed PDF, with a page of signatures at the end, is in your Drive: ${baseUrl(req)}/drive/signatures`
        : `Everyone has signed “${s.title}”.\n\nThe document is locked, with the signatures, in Workspace: ${baseUrl(req)}/docs/${s.file_id}`);
    }
    tell(reqRow);
    res.json(shown(find(req.params.token)));
  });
  // Decline to sign, with a reason: the request stops, the document is unlocked, and the sender is told.
  r.post('/:token/decline', async (req, res) => {
    const s = find(req.params.token);
    if (s.signed_at) throw bad('You have already signed this');
    if (s.status !== 'pending') throw bad('This is no longer waiting for signatures');
    const reason = str(req.body?.reason ?? '', { max: 500 }) || null;
    const who = s.name || q('SELECT name FROM users WHERE id = ?').get(s.user_id)?.name || s.email;
    tx(() => {
      q("UPDATE sign_requests SET status = 'declined', completed_at = ?, declined_by = ?, decline_reason = ? WHERE id = ?").run(now(), who, reason, s.rid);
      q('UPDATE files SET locked_by = NULL, locked_at = NULL WHERE id = ? AND locked_by = ?').run(s.file_id, s.requested_by);
    });
    const reqRow = q('SELECT * FROM sign_requests WHERE id = ?').get(s.rid);
    if (s.requested_by) {
      bell([s.requested_by], { kind: 'share', title: `${who} declined to sign “${s.title}”`, body: reason, link: linkTo(s.file_id), actor: who });
      const requester = q('SELECT * FROM users WHERE id = ?').get(s.requested_by);
      if (requester) await mailSigner(requester, requester.username, `Declined: ${s.title}`, `${who} (${s.email}) declined to sign “${s.title}”.${reason ? `\n\nTheir reason: ${reason}` : ''}\n\nThe document is unlocked again: ${baseUrl(req)}${linkTo(s.file_id)}`);
    }
    sendTo(new Set(peopleOf(reqRow)), { type: 'file-locked', id: s.file_id, locked_at: null, by_name: who });
    tell(reqRow);
    res.json(shown(find(req.params.token)));
  });
  return r;
}
