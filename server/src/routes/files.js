import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { q, tx, FILES_DIR, TMP_DIR } from '../db.js';
import { uid, now, str, bad, forbidden, notFound, HttpError, mimeFor, isInlineSafe } from '../util.js';
import { roleFor, atLeast, audienceFor, subtreeIds } from '../access.js';
import { sendTo } from '../hub.js';

const COLS = `f.id, f.owner_id, f.parent_id, f.name, f.kind, f.mime, f.size, f.version, f.trashed,
              f.created_at, f.updated_at, u.name AS owner_name, ub.name AS updated_by_name`;
const FROM = `FROM files f JOIN users u ON u.id = f.owner_id LEFT JOIN users ub ON ub.id = f.updated_by`;
const ORDER = `ORDER BY (f.kind = 'folder') DESC, f.name COLLATE NOCASE`;

const EMPTY = {
  doc: () => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
  sheet: () => JSON.stringify({ sheets: [{ name: 'Sheet1', cells: {}, colWidths: {} }] }),
};

function cleanName(name) {
  const n = str(name, { required: true, name: 'Name', max: 255 });
  if (/[\/\\\0]/.test(n) || n === '.' || n === '..') throw bad('Name contains invalid characters');
  return n;
}

function loadFile(id, user, needed = 'viewer') {
  const f = q(`SELECT ${COLS}, f.storage ${FROM} WHERE f.id = ?`).get(id);
  if (!f) throw notFound('File not found');
  const role = roleFor(id, user.id);
  if (!role) throw notFound('File not found');
  if (!atLeast(role, needed)) throw forbidden(`You need ${needed} access`);
  f.role = role;
  return f;
}

function publicFile(f, role) {
  const { storage, ...rest } = f;
  return { ...rest, role: role ?? f.role };
}

function notify(fileId, payload) {
  sendTo(audienceFor(fileId), payload);
}

/** Parent folder for a new item; null means the user's root. */
function resolveParent(parentId, user) {
  if (!parentId) return null;
  const p = loadFile(parentId, user, 'editor');
  if (p.kind !== 'folder') throw bad('Parent is not a folder');
  return p.id;
}

function uniqueName(parentId, ownerId, name) {
  const exists = (n) => parentId
    ? q('SELECT 1 FROM files WHERE parent_id = ? AND name = ? AND trashed = 0').get(parentId, n)
    : q('SELECT 1 FROM files WHERE parent_id IS NULL AND owner_id = ? AND name = ? AND trashed = 0').get(ownerId, n);
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!exists(n)) return n; }
  return `${base} (${Date.now()})${ext}`;
}

function insertFile({ owner, parentId, name, kind, mime = null, size = 0, storage = null, content = null }) {
  const id = uid();
  const t = now();
  q(`INSERT INTO files (id, owner_id, parent_id, name, kind, mime, size, storage, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, owner, parentId, uniqueName(parentId, owner, name), kind, mime, size, storage, content, t, t, owner);
  return id;
}

function permanentlyDelete(fileId) {
  const ids = subtreeIds(fileId);
  const stored = ids.map((id) => q('SELECT storage FROM files WHERE id = ?').get(id)?.storage).filter(Boolean);
  q('DELETE FROM files WHERE id = ?').run(fileId);
  for (const s of stored) fs.rm(path.join(FILES_DIR, s), { force: true }, () => {});
}

export default function fileRoutes({ maxUploadBytes }) {
  const r = Router();

  // List: ?view=mine|shared|recent|trash|search & parent= & q=
  r.get('/', (req, res) => {
    const me = req.user.id;
    const view = req.query.view || 'mine';
    let rows;
    if (view === 'mine') {
      if (req.query.parent) {
        const parent = loadFile(req.query.parent, req.user);
        if (parent.kind !== 'folder') throw bad('Not a folder');
        rows = q(`SELECT ${COLS} ${FROM} WHERE f.parent_id = ? AND f.trashed = 0 ${ORDER}`).all(parent.id);
        rows = rows.map((f) => publicFile(f, parent.role));
        for (const f of rows) if (f.owner_id === me) f.role = 'owner';
      } else {
        rows = q(`SELECT ${COLS} ${FROM} WHERE f.owner_id = ? AND f.parent_id IS NULL AND f.trashed = 0 ${ORDER}`)
          .all(me).map((f) => publicFile(f, 'owner'));
      }
    } else if (view === 'shared') {
      rows = q(`SELECT ${COLS}, s.role ${FROM} JOIN shares s ON s.file_id = f.id
                WHERE s.user_id = ? AND f.trashed = 0 ${ORDER}`).all(me);
    } else if (view === 'recent') {
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE s.role END AS role ${FROM}
                LEFT JOIN shares s ON s.file_id = f.id AND s.user_id = ?
                WHERE (f.owner_id = ? OR s.user_id IS NOT NULL) AND f.kind != 'folder' AND f.trashed = 0
                ORDER BY f.updated_at DESC LIMIT 50`).all(me, me, me);
    } else if (view === 'trash') {
      rows = q(`SELECT ${COLS} ${FROM} WHERE f.owner_id = ? AND f.trashed = 1 ORDER BY f.updated_at DESC`)
        .all(me).map((f) => publicFile(f, 'owner'));
    } else if (view === 'search') {
      const term = `%${String(req.query.q || '').replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE s.role END AS role ${FROM}
                LEFT JOIN shares s ON s.file_id = f.id AND s.user_id = ?
                WHERE (f.owner_id = ? OR s.user_id IS NOT NULL) AND f.trashed = 0 AND f.name LIKE ? ESCAPE '\\'
                ${ORDER} LIMIT 200`).all(me, me, me, term);
    } else throw bad('Unknown view');
    res.json(rows);
  });

  r.get('/usage', (req, res) => {
    const used = q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ?').get(req.user.id).n;
    let disk = null;
    try { const s = fs.statfsSync(FILES_DIR); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
    res.json({ used, disk });
  });

  r.post('/folder', (req, res) => {
    const parentId = resolveParent(req.body.parent_id, req.user);
    const id = insertFile({ owner: req.user.id, parentId, name: cleanName(req.body.name), kind: 'folder' });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/new', (req, res) => {
    const kind = req.body.kind;
    if (!EMPTY[kind]) throw bad('kind must be doc or sheet');
    const parentId = resolveParent(req.body.parent_id, req.user);
    const name = cleanName(req.body.name || (kind === 'doc' ? 'Untitled document' : 'Untitled spreadsheet'));
    const content = req.body.content !== undefined ? JSON.stringify(req.body.content) : EMPTY[kind]();
    const id = insertFile({ owner: req.user.id, parentId, name, kind, content, size: Buffer.byteLength(content) });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  // Raw streaming upload: POST /upload?parent=&name=  (body = file bytes)
  r.post('/upload', async (req, res) => {
    const parentId = resolveParent(req.query.parent, req.user);
    const name = cleanName(String(req.query.name || ''));
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxUploadBytes) throw new HttpError(413, 'File is too large');
    const storage = uid();
    const tmp = path.join(TMP_DIR, storage);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > maxUploadBytes) return cb(new HttpError(413, 'File is too large'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(tmp));
      fs.renameSync(tmp, path.join(FILES_DIR, storage));
    } catch (e) {
      fs.rm(tmp, { force: true }, () => {});
      throw e instanceof HttpError ? e : new HttpError(400, 'Upload interrupted');
    }
    const id = insertFile({ owner: req.user.id, parentId, name, kind: 'file', mime: mimeFor(name), size, storage });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/empty-trash', (req, res) => {
    const ids = q('SELECT id FROM files WHERE owner_id = ? AND trashed = 1').all(req.user.id);
    tx(() => { for (const { id } of ids) permanentlyDelete(id); });
    res.json({ deleted: ids.length });
  });

  r.get('/:id', (req, res) => {
    res.json(publicFile(loadFile(req.params.id, req.user)));
  });

  // Breadcrumb path from the top-most folder this user can see.
  r.get('/:id/path', (req, res) => {
    const out = [];
    let cur = loadFile(req.params.id, req.user);
    for (let d = 0; cur && d < 64; d++) {
      out.unshift({ id: cur.id, name: cur.name });
      if (!cur.parent_id || !roleFor(cur.parent_id, req.user.id)) break;
      cur = q('SELECT id, name, parent_id FROM files WHERE id = ?').get(cur.parent_id);
    }
    res.json(out);
  });

  r.get('/:id/raw', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'file') throw bad('Not a binary file');
    const inline = req.query.download === undefined && isInlineSafe(f.mime);
    res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Lock down anything rendered on our origin (the PDF viewer needs default CSP to work).
    if (f.mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'private, max-age=0' } });
  });

  r.get('/:id/content', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'doc' && f.kind !== 'sheet') throw bad('No editable content');
    const { content } = q('SELECT content FROM files WHERE id = ?').get(f.id);
    res.json({ file: publicFile(f), content: JSON.parse(content) });
  });

  // Save with optimistic concurrency: client sends the version it edited.
  r.put('/:id/content', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (f.kind !== 'doc' && f.kind !== 'sheet') throw bad('No editable content');
    const json = JSON.stringify(req.body.content ?? null);
    const result = q(`UPDATE files SET content = ?, size = ?, version = version + 1, updated_at = ?, updated_by = ?
                      WHERE id = ? AND version = ?`)
      .run(json, Buffer.byteLength(json), now(), req.user.id, f.id, Number(req.body.version));
    if (!result.changes) {
      const cur = q('SELECT content, version FROM files WHERE id = ?').get(f.id);
      return res.status(409).json({ error: 'Someone else changed this file', version: cur.version, content: JSON.parse(cur.content) });
    }
    const version = f.version + 1;
    notify(f.id, { type: 'content-changed', id: f.id, version, by: req.user.id, by_name: req.user.name });
    res.json({ version });
  });

  r.patch('/:id', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const { name, parent_id, trashed } = req.body;
    tx(() => {
      if (name !== undefined) {
        const n = cleanName(name);
        if (n !== f.name) q('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(uniqueName(f.parent_id, f.owner_id, n), now(), f.id);
      }
      if (parent_id !== undefined && parent_id !== f.parent_id) {
        if (parent_id === null) {
          if (f.role !== 'owner' || f.owner_id !== req.user.id) throw forbidden('Only the owner can move this to their root');
        } else {
          resolveParent(parent_id, req.user);
          if (subtreeIds(f.id).includes(parent_id)) throw bad('Cannot move a folder into itself');
        }
        q('UPDATE files SET parent_id = ? WHERE id = ?').run(parent_id, f.id);
      }
      if (trashed !== undefined) q('UPDATE files SET trashed = ?, updated_at = ? WHERE id = ?').run(trashed ? 1 : 0, now(), f.id);
    });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  r.delete('/:id', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const audience = audienceFor(f.id);
    tx(() => permanentlyDelete(f.id));
    sendTo(audience, { type: 'files-changed', parent_id: f.parent_id });
    res.json({ ok: true });
  });

  r.get('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(q(`SELECT s.user_id, s.role, u.name, u.username FROM shares s JOIN users u ON u.id = s.user_id
                WHERE s.file_id = ? ORDER BY u.name`).all(f.id));
  });

  // Replace the share list: [{ user_id, role }]
  r.put('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const list = Array.isArray(req.body.shares) ? req.body.shares : null;
    if (!list) throw bad('shares must be an array');
    const before = audienceFor(f.id);
    tx(() => {
      q('DELETE FROM shares WHERE file_id = ?').run(f.id);
      for (const s of list) {
        if (!['viewer', 'editor'].includes(s.role)) throw bad('role must be viewer or editor');
        if (s.user_id === f.owner_id) continue;
        if (!q('SELECT 1 FROM users WHERE id = ?').get(s.user_id)) throw bad('Unknown user');
        q('INSERT INTO shares (file_id, user_id, role) VALUES (?, ?, ?)').run(f.id, s.user_id, s.role);
      }
    });
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    res.json({ ok: true });
  });

  return r;
}
