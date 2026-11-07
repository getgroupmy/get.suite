// Public share links: send a file or folder to someone without an account, or (for a folder) ask
// for files: an upload link lets people send files into it without seeing what's there. The owner can set an
// expiry date and a password, and revoke a link at any time. A link stops working by itself when
// the file is trashed or deleted, the owner is disabled or loses the file, or the company turns
// links off.
import { Router } from 'express';
import { audit } from '../audit.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { q, FILES_DIR } from '../db.js';
import { uid, now, bad, notFound, forbidden, HttpError, isInlineSafe, mimeFor } from '../util.js';
import { roleFor, subtreeIds } from '../access.js';
import { hashPassword, verifyPassword } from '../auth.js';
import * as guard from '../security/guard.js';
import { receiveUpload, insertFile, cleanName } from './files.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';

const LINKABLE = ['file', 'folder'];
const MAX_EXPIRY_DAYS = 365;

/** The proof of a typed password, sent with later requests; changes if the password changes. */
const keyFor = (link) => crypto.createHash('sha256').update(`${link.token}:${link.password_hash}`).digest('base64url').slice(0, 32);
const sameKey = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function describeLink(l) {
  return { id: l.id, token: l.token, file_id: l.file_id, mode: l.mode || 'view', created_at: l.created_at, expires_at: l.expires_at,
    has_password: !!l.password_hash, opens: l.opens, last_opened: l.last_opened, expired: !!l.expires_at && l.expires_at <= now() };
}

/** Is the item (or a folder above it, up to `stopAt`) in the trash? */
function trashedOnTheWay(fileId, stopAt = null) {
  let cur = fileId;
  for (let depth = 0; cur && depth < 64; depth++) {
    const f = q('SELECT parent_id, trashed FROM files WHERE id = ?').get(cur);
    if (!f || f.trashed) return true;
    if (cur === stopAt) return false;
    cur = f.parent_id;
  }
  return false;
}

/** Owner-side checks: the file exists, you own it, it can have links, and your company allows them. */
function ownFile(fileId, user) {
  const f = q('SELECT id, kind, name, trashed FROM files WHERE id = ?').get(String(fileId || ''));
  if (!f || !roleFor(f.id, user.id)) throw notFound('File not found');
  if (roleFor(f.id, user.id) !== 'owner') throw forbidden('Only the owner can create or remove links');
  return f;
}
const linksAllowed = (orgId) => !!q('SELECT allow_links FROM orgs WHERE id = ?').get(orgId)?.allow_links;

/** Signed-in owners: list, create and remove links. Mounted at /api/links. */
export function linkRoutes() {
  const r = Router();

  r.get('/', (req, res) => {
    const f = ownFile(req.query.file, req.user);
    res.json(q('SELECT * FROM share_links WHERE file_id = ? ORDER BY created_at').all(f.id).map(describeLink));
  });

  r.post('/', (req, res) => {
    const f = ownFile(req.body.file_id, req.user);
    if (!linksAllowed(req.user.org_id)) throw forbidden('Your company has turned off public links');
    if (!LINKABLE.includes(f.kind)) throw bad('Links work for uploaded files and folders');
    if (f.trashed) throw bad('Restore the file from the trash first');
    let expires = null;
    if (req.body.expires_at != null) {
      expires = Number(req.body.expires_at);
      if (!Number.isFinite(expires) || expires <= now()) throw bad('Pick an expiry date in the future');
      if (expires > now() + MAX_EXPIRY_DAYS * 864e5) throw bad(`Links can last at most ${MAX_EXPIRY_DAYS} days`);
    }
    const mode = req.body.mode === 'upload' ? 'upload' : 'view';
    if (mode === 'upload' && f.kind !== 'folder') throw bad('File requests are for folders');
    const password = req.body.password ? String(req.body.password) : '';
    if (password && password.length < 6) throw bad('Use a password of at least 6 characters');
    if (password.length > 200) throw bad('Password is too long');
    const link = { id: uid(), token: crypto.randomBytes(18).toString('base64url'), file_id: f.id, created_by: req.user.id, mode,
      created_at: now(), expires_at: expires, password_hash: password ? hashPassword(password) : null, opens: 0, last_opened: null };
    q(`INSERT INTO share_links (id, token, file_id, created_by, created_at, expires_at, password_hash, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(link.id, link.token, link.file_id, link.created_by, link.created_at, link.expires_at, link.password_hash, mode);
    audit(req, mode === 'upload' ? 'link.request' : 'link.create', { target: f.name, details: { password: !!password, expires: expires } });
    res.json(describeLink(link));
  });

  r.delete('/:id', (req, res) => {
    const l = q('SELECT * FROM share_links WHERE id = ?').get(req.params.id);
    if (!l) throw notFound('Link not found');
    ownFile(l.file_id, req.user);
    q('DELETE FROM share_links WHERE id = ?').run(l.id);
    audit(req, 'link.delete', { target: q('SELECT name FROM files WHERE id = ?').get(l.file_id)?.name });
    res.json({ ok: true });
  });

  return r;
}

/** A link that still works, or an error that says why it doesn't (without revealing the file). */
function liveLink(token) {
  const l = q(`SELECT l.*, f.name, f.kind, f.mime, f.size, f.updated_at, u.name AS owner_name, u.disabled, u.org_id, o.name AS org_name, o.allow_links
               FROM share_links l JOIN files f ON f.id = l.file_id JOIN users u ON u.id = l.created_by JOIN orgs o ON o.id = u.org_id
               WHERE l.token = ?`).get(String(token || ''));
  const gone = () => new HttpError(404, 'This link doesn’t work. It may have been removed, or the file is no longer shared.');
  if (!l || l.disabled || !l.allow_links || roleFor(l.file_id, l.created_by) !== 'owner' || trashedOnTheWay(l.file_id)) throw gone();
  if (l.expires_at && l.expires_at <= now()) throw new HttpError(410, 'This link has expired. Ask the person who sent it for a new one.');
  return l;
}

const unlocked = (l, req) => !l.password_hash || sameKey(req.get('x-link-key') || req.query.key, keyFor(l));

/** An item reachable through the link: the linked file itself, or anything inside the linked folder. */
function itemIn(l, itemId) {
  if (!itemId || itemId === l.file_id) return q('SELECT * FROM files WHERE id = ?').get(l.file_id);
  if (l.kind !== 'folder') throw notFound('Not found');
  const f = q('SELECT * FROM files WHERE id = ?').get(String(itemId));
  if (!f || !LINKABLE.includes(f.kind) || !subtreeIds(l.file_id).includes(f.id) || trashedOnTheWay(f.id, l.file_id)) throw notFound('Not found');
  return f;
}

const shown = (f) => ({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, size: f.size, updated_at: f.updated_at });

/** No account needed. Mounted at /api/public (before the signed-in routes). */
export function publicLinkRoutes({ maxUploadBytes = 4096 * 1024 * 1024 } = {}) {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });

  // What the link points to; for a folder, what's in it (?folder= for a folder inside it).
  r.get('/links/:token', (req, res) => {
    const l = liveLink(req.params.token);
    const info = { name: l.name, kind: l.kind, owner_name: l.owner_name, org_name: l.org_name, expires_at: l.expires_at, locked: !unlocked(l, req) };
    if (info.locked) return res.json(info);
    if (!req.query.folder) q('UPDATE share_links SET opens = opens + 1, last_opened = ? WHERE id = ?').run(now(), l.id);
    if (l.mode === 'upload') return res.json({ ...info, mode: 'upload' }); // a file request: nothing in the folder is shown
    Object.assign(info, { mime: l.mime, size: l.size, updated_at: l.updated_at, root: l.file_id });
    if (l.kind === 'folder') {
      const folder = itemIn(l, req.query.folder);
      if (folder.kind !== 'folder') throw bad('Not a folder');
      info.items = q(`SELECT * FROM files WHERE parent_id = ? AND trashed = 0 AND kind IN ('file', 'folder')
                      ORDER BY (kind = 'folder') DESC, name COLLATE NOCASE`).all(folder.id).map(shown);
      // Breadcrumbs from the linked folder down to this one.
      const trail = [];
      for (let cur = folder; cur; cur = cur.id === l.file_id ? null : q('SELECT * FROM files WHERE id = ?').get(cur.parent_id)) trail.unshift({ id: cur.id, name: cur.name });
      info.path = trail;
    }
    res.json(info);
  });

  // Type the password; the answer is a key to send with the other requests.
  r.post('/links/:token/unlock', async (req, res) => {
    const l = liveLink(req.params.token);
    if (!l.password_hash) return res.json({ key: '' });
    const verdict = guard.check(req.ip, `link:${l.id}`);
    if (verdict.action === 'reject') throw new HttpError(429, 'Too many wrong passwords from your network. Try again later.');
    if (verdict.action === 'delay') await new Promise((ok) => setTimeout(ok, verdict.seconds * 1000));
    const password = String(req.body.password || '');
    if (!verifyPassword(password, l.password_hash)) {
      guard.recordFailure({ ip: req.ip, login: `link:${l.id}`, fp: guard.passwordFingerprint(password), service: 'link' });
      throw new HttpError(401, 'That password is not right');
    }
    res.json({ key: keyFor(l) });
  });

  // The file itself (?item= for a file inside a linked folder; ?download to save it).
  r.get('/links/:token/raw', (req, res) => {
    const l = liveLink(req.params.token);
    if (!unlocked(l, req)) throw new HttpError(401, 'This link needs a password');
    if (l.mode === 'upload') throw notFound('Not found');
    const f = itemIn(l, req.query.item);
    if (f.kind !== 'file') throw bad('Not a file');
    const inline = req.query.download === undefined && isInlineSafe(f.mime);
    res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
    if (f.mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(path.join(FILES_DIR, f.storage));
  });

  // A file request: send one file into the linked folder (?name=, &from= who's sending it). The file
  // belongs to the folder's owner and counts towards their company's storage.
  r.post('/links/:token/upload', async (req, res) => {
    const l = liveLink(req.params.token);
    if (l.mode !== 'upload') throw notFound('Not found');
    if (!unlocked(l, req)) throw new HttpError(401, 'This link needs a password');
    const verdict = guard.check(req.ip, `upload:${l.id}`);
    if (verdict.action === 'reject') throw new HttpError(429, 'Too many uploads from your network. Try again later.');
    const name = cleanName(String(req.query.name || ''));
    const from = String(req.query.from || '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 100);
    const { storage, size } = await receiveUpload(req, l.org_id, maxUploadBytes);
    const id = insertFile({ owner: l.created_by, parentId: l.file_id, name, kind: 'file', mime: mimeFor(name), size, storage, activity: { by: null, action: 'request', details: { from: from || null } } });
    q('UPDATE files SET description = ? WHERE id = ?').run(`Sent${from ? ` by ${from}` : ''} through a file request`, id);
    const saved = q('SELECT name FROM files WHERE id = ?').get(id).name;
    bell([l.created_by], { kind: 'share', title: `${from || 'Someone'} sent “${saved}”`, body: `Into ${l.name} through a file request`, link: `/drive/folder/${l.file_id}`, actor: from || null });
    sendTo([l.created_by], { type: 'files-changed', parent_id: l.file_id });
    res.status(201).json({ name: saved, size });
  });

  return r;
}
