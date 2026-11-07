import { notify as bell } from '../notifications.js';
import { Router } from 'express';
import { audit } from '../audit.js';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { q, tx, FILES_DIR, TMP_DIR } from '../db.js';
import { contentMatches, indexSoon } from '../search.js';
import { readSetup } from '../pagesetup.js';
import JSZip from 'jszip';
import { uid, now, str, bad, forbidden, notFound, HttpError, mimeFor, isInlineSafe } from '../util.js';
import { roleFor, atLeast, audienceFor, subtreeIds } from '../access.js';
import { sendTo } from '../hub.js';
import { canReach, checkQuota } from '../tenancy.js';
import { resetRoom, CO_EDITED, saveNow } from '../collab.js';
import { docFromWord, wordFromDoc } from '../office/word.js';
import { sheetFromExcel, excelFromSheet } from '../office/excel.js';
import { deckFromPowerPoint, powerPointFromDeck } from '../office/powerpoint.js';

// Office files that open as Docs, Sheets and Slides (and download back in the same format).
const OFFICE = {
  docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};
const EXPORT_AS = { doc: 'docx', sheet: 'xlsx', slides: 'pptx' };
const MAX_CONVERT = 50 * 1024 * 1024;
const officeType = (name) => OFFICE[(/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase()] ? (/\.([a-z]+)$/i.exec(name)[1].toLowerCase()) : null;

const COLS = `f.id, f.owner_id, f.parent_id, f.name, f.kind, f.mime, f.size, f.version, f.trashed, f.trashed_at, f.page_setup, f.color, f.description,
              f.created_at, f.updated_at, u.name AS owner_name, ub.name AS updated_by_name`;
const FROM = `FROM files f JOIN users u ON u.id = f.owner_id LEFT JOIN users ub ON ub.id = f.updated_by`;
// Owner is in my company, or both companies currently allow external collaboration.
const REACHABLE = `(u.org_id = ? OR (SELECT MIN(allow_external) FROM orgs WHERE id IN (u.org_id, ?)) = 1)`;
const ORDER = `ORDER BY (f.kind = 'folder') DESC, f.name COLLATE NOCASE`;

const EMPTY = {
  doc: () => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
  sheet: () => JSON.stringify({ sheets: [{ name: 'Sheet1', cells: {}, colWidths: {} }] }),
  slides: () => JSON.stringify({ theme: 'light', slides: [{ id: uid(), items: [
    { id: uid(), type: 'text', role: 'title', x: 8, y: 30, w: 84, h: 20, text: '', size: 44, bold: true, align: 'center' },
    { id: uid(), type: 'text', role: 'subtitle', x: 15, y: 54, w: 70, h: 12, text: '', size: 24, align: 'center' },
  ] }] }),
};
const EDITABLE = ['doc', 'sheet', 'slides'];
/** Where a file opens in Workspace. */
const openLink = (f) => ({ folder: `/drive/folder/${f.id}`, doc: `/docs/${f.id}`, sheet: `/sheets/${f.id}`, slides: `/slides/${f.id}` }[f.kind] || '/drive/shared');
const setupOf = (f) => { if (!f.page_setup || typeof f.page_setup === 'object') return f.page_setup || null; try { return JSON.parse(f.page_setup); } catch { return null; } };

export function cleanName(name) {
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
  const { storage, page_setup: setup, ...rest } = f;
  return { ...rest, ...(f.kind === 'doc' && { page_setup: setupOf({ page_setup: setup }) }), role: role ?? f.role };
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

export function uniqueName(parentId, ownerId, name) {
  const exists = (n) => parentId
    ? q('SELECT 1 FROM files WHERE parent_id = ? AND name = ? AND trashed = 0').get(parentId, n)
    : q('SELECT 1 FROM files WHERE parent_id IS NULL AND owner_id = ? AND name = ? AND trashed = 0').get(ownerId, n);
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!exists(n)) return n; }
  return `${base} (${Date.now()})${ext}`;
}

export function insertFile({ owner, parentId, name, kind, mime = null, size = 0, storage = null, content = null }) {
  const id = uid();
  const t = now();
  q(`INSERT INTO files (id, owner_id, parent_id, name, kind, mime, size, storage, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, owner, parentId, uniqueName(parentId, owner, name), kind, mime, size, storage, content, t, t, owner);
  return id;
}

/** Delete for good what has been in the trash longer than its company keeps it. Returns how many went. */
export function emptyOldTrash(at = now()) {
  const old = q(`SELECT f.id FROM files f JOIN users u ON u.id = f.owner_id JOIN orgs o ON o.id = u.org_id
                 WHERE f.trashed = 1 AND o.trash_days > 0 AND COALESCE(f.trashed_at, f.updated_at) < ? - o.trash_days * 86400000`).all(at);
  tx(() => { for (const { id } of old) if (q('SELECT 1 FROM files WHERE id = ?').get(id)) permanentlyDelete(id); });
  return old.length;
}

function permanentlyDelete(fileId) {
  const ids = subtreeIds(fileId);
  const stored = ids.flatMap((id) => [q('SELECT storage FROM files WHERE id = ?').get(id)?.storage,
    ...q('SELECT storage FROM file_versions WHERE file_id = ?').all(id).map((v) => v.storage)]).filter(Boolean);
  q('DELETE FROM files WHERE id = ?').run(fileId);
  for (const s of stored) fs.rm(path.join(FILES_DIR, s), { force: true }, () => {});
}

// ---- version history ----
const KEEP_VERSIONS = Number(process.env.KEEP_VERSIONS || 50);
const SESSION_MS = 10 * 60e3; // Docs/Sheets: a pause this long (or another editor) starts a new version

/** Keep a version when someone else edited last, or after a pause (one per editing session). */
export function snapshotIfNewSession(fileId, userId) {
  const cur = q('SELECT version, updated_at, updated_by, owner_id FROM files WHERE id = ?').get(fileId);
  if (cur && cur.version > 1 && ((cur.updated_by || cur.owner_id) !== userId || now() - cur.updated_at > SESSION_MS)) snapshot(fileId);
}

/** Keep the file as it is now as an earlier version (and drop the oldest beyond the limit). */
export function snapshot(fileId, label = null) {
  const f = q('SELECT * FROM files WHERE id = ?').get(fileId);
  const id = uid();
  q(`INSERT INTO file_versions (id, file_id, version, name, saved_at, saved_by, size, mime, storage, content, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, f.id, f.version, f.name, f.updated_at, f.updated_by || f.owner_id, f.size, f.mime, f.storage, f.content, label);
  // Named versions are kept; the oldest of the others go beyond the limit.
  const old = q('SELECT id, storage FROM file_versions WHERE file_id = ? AND label IS NULL ORDER BY saved_at DESC, version DESC LIMIT -1 OFFSET ?').all(f.id, KEEP_VERSIONS);
  for (const v of old) {
    q('DELETE FROM file_versions WHERE id = ?').run(v.id);
    if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
  }
  return id;
}

/** Stream an upload into storage, within the size limit and the company's quota. */
export async function receiveUpload(req, orgId, maxUploadBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxUploadBytes) throw new HttpError(413, 'File is too large');
  checkQuota(orgId, declared);
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
    checkQuota(orgId, size); // Content-Length can be absent (chunked uploads)
    fs.renameSync(tmp, path.join(FILES_DIR, storage));
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    throw e instanceof HttpError ? e : new HttpError(400, 'Upload interrupted');
  }
  return { storage, size };
}

/** The Drive files a presentation or document shows as pictures (their ids). */
export function picturesIn(kind, content) {
  const ids = new Set();
  if (kind === 'slides') for (const sl of content.slides || []) for (const it of sl.items || []) { if (it.type === 'image' && it.fileId) ids.add(it.fileId); }
  if (kind === 'doc') {
    const walk = (n) => { if (n?.type === 'image' && n.attrs?.fileId) ids.add(n.attrs.fileId); for (const c of n?.content || []) walk(c); };
    walk(content);
  }
  return ids;
}

q(`CREATE TABLE IF NOT EXISTS file_stars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
)`).run();
const MAX_ZIP_BYTES = 2 * 1024 ** 3, MAX_ZIP_FILES = 20000;

/** The kinds of file search can be narrowed to: Workspace files and the usual uploads of the same kind. */
const SEARCH_TYPES = {
  folder: "f.kind = 'folder'",
  doc: "f.kind = 'doc' OR (f.kind = 'file' AND (f.name LIKE '%.docx' OR f.name LIKE '%.doc' OR f.name LIKE '%.odt' OR f.name LIKE '%.rtf' OR f.name LIKE '%.txt' OR f.name LIKE '%.md'))",
  sheet: "f.kind = 'sheet' OR (f.kind = 'file' AND (f.name LIKE '%.xlsx' OR f.name LIKE '%.xls' OR f.name LIKE '%.ods' OR f.name LIKE '%.csv'))",
  slides: "f.kind = 'slides' OR (f.kind = 'file' AND (f.name LIKE '%.pptx' OR f.name LIKE '%.ppt' OR f.name LIKE '%.odp'))",
  pdf: "f.kind = 'file' AND (f.mime = 'application/pdf' OR f.name LIKE '%.pdf')",
  image: "f.kind = 'file' AND f.mime LIKE 'image/%'",
  video: "f.kind = 'file' AND f.mime LIKE 'video/%'",
  audio: "f.kind = 'file' AND f.mime LIKE 'audio/%'",
  archive: "f.kind = 'file' AND (f.name LIKE '%.zip' OR f.name LIKE '%.7z' OR f.name LIKE '%.rar' OR f.name LIKE '%.tar' OR f.name LIKE '%.gz')",
};

export default function fileRoutes({ maxUploadBytes }) {
  const r = Router();
  // After any change, the search index catches up within a couple of seconds.
  r.use((req, res, next) => { if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 300) indexSoon(); }); next(); });

  // List: ?view=mine|shared|recent|trash|search & parent= & q= (search: & type= & owner=me|others & modified=days)
  r.get('/', (req, res) => {
    const me = req.user.id;
    const org = req.user.org_id;
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
                WHERE s.user_id = ? AND f.trashed = 0 AND ${REACHABLE} ${ORDER}`).all(me, org, org);
    } else if (view === 'recent') {
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE s.role END AS role ${FROM}
                LEFT JOIN shares s ON s.file_id = f.id AND s.user_id = ?
                WHERE (f.owner_id = ? OR s.user_id IS NOT NULL) AND f.kind != 'folder' AND f.trashed = 0 AND ${REACHABLE}
                ORDER BY f.updated_at DESC LIMIT 50`).all(me, me, me, org, org);
    } else if (view === 'starred') {
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE NULL END AS role ${FROM}
                JOIN file_stars st ON st.file_id = f.id AND st.user_id = ?
                WHERE f.trashed = 0 ${ORDER}`).all(me, me)
        .map((f) => ({ ...f, role: roleFor(f.id, me) })).filter((f) => f.role); // only what you can still open
    } else if (view === 'trash') {
      // With when each goes for good, when the company empties the trash after a while.
      const days = q('SELECT o.trash_days FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.id = ?').get(me)?.trash_days ?? 30;
      rows = q(`SELECT ${COLS} ${FROM} WHERE f.owner_id = ? AND f.trashed = 1 ORDER BY f.trashed_at DESC, f.updated_at DESC`)
        .all(me).map((f) => ({ ...publicFile(f, 'owner'), ...(days > 0 && { deletes_at: (f.trashed_at || f.updated_at) + days * 864e5 }) }));
    } else if (view === 'search') {
      // By name, or by the words inside (documents, spreadsheets, presentations, text and Office files).
      const term = `%${String(req.query.q || '').replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      const inside = contentMatches(req.query.q);
      const ids = JSON.stringify([...inside.keys()]);
      // Filters: the kind of file, whose it is, and when it last changed.
      const extra = [], args = [];
      const type = SEARCH_TYPES[req.query.type];
      if (req.query.type && !type) throw bad('Unknown file type');
      if (type) extra.push(type);
      if (req.query.owner === 'me') { extra.push('f.owner_id = ?'); args.push(me); }
      else if (req.query.owner === 'others') { extra.push('f.owner_id != ?'); args.push(me); }
      const days = Number(req.query.modified);
      if (req.query.modified && !(days > 0)) throw bad('Bad date filter');
      if (days > 0) { extra.push('f.updated_at >= ?'); args.push(Date.now() - days * 864e5); }
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE s.role END AS role ${FROM}
                LEFT JOIN shares s ON s.file_id = f.id AND s.user_id = ?
                WHERE (f.owner_id = ? OR s.user_id IS NOT NULL) AND f.trashed = 0
                  AND (f.name LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' OR f.id IN (SELECT value FROM json_each(?))) AND ${REACHABLE}
                  ${extra.map((x) => `AND (${x})`).join(' ')}
                ${ORDER} LIMIT 200`).all(me, me, me, term, term, ids, org, org, ...args);
      // Name matches first, then the best content matches; each content match says where it matched.
      const rank = new Map([...inside.keys()].map((id, i) => [id, i]));
      const byName = (f) => f.name.toLowerCase().includes(String(req.query.q || '').toLowerCase());
      rows = rows.map((f) => (inside.has(f.id) && !byName(f) ? { ...f, match: inside.get(f.id) } : f))
        .sort((a, b) => (byName(b) - byName(a)) || ((rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)));
    } else throw bad('Unknown view');
    // Your stars on what's listed.
    const starred = new Set(q('SELECT file_id FROM file_stars WHERE user_id = ? AND file_id IN (SELECT value FROM json_each(?))').all(me, JSON.stringify(rows.map((f) => f.id))).map((x) => x.file_id));
    res.json(rows.map((f) => (starred.has(f.id) ? { ...f, starred: true } : f)));
  });

  // Download several files and folders as one .zip; documents, spreadsheets and presentations as
  // Word, Excel and PowerPoint files. Only what you can open, and not what's in the bin.
  r.get('/zip', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500);
    if (!ids.length) throw bad('Choose files to download');
    const entries = [];
    let total = 0;
    const used = new Set();
    const unique = (p) => { let n = p, i = 1; while (used.has(n.toLowerCase())) { const dot = p.lastIndexOf('.'); n = dot > p.lastIndexOf('/') ? `${p.slice(0, dot)} (${i})${p.slice(dot)}` : `${p} (${i})`; i++; } used.add(n.toLowerCase()); return n; };
    const safe = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'untitled';
    const add = (f, dir) => {
      if (entries.length >= MAX_ZIP_FILES) throw bad('Too many files for one download');
      if (f.kind === 'folder') {
        const here = unique(`${dir}${safe(f.name)}`);
        entries.push({ folder: true, path: `${here}/` });
        for (const c of q("SELECT id, name, kind, size, storage, content, mime FROM files WHERE parent_id = ? AND trashed = 0 ORDER BY name").all(f.id)) add(c, `${here}/`);
        return;
      }
      if (f.kind === 'file') { total += f.size || 0; if (total > MAX_ZIP_BYTES) throw bad('More than 2 GB: download fewer files at a time'); }
      const ext = { doc: '.docx', sheet: '.xlsx', slides: '.pptx' }[f.kind] || '';
      entries.push({ f, path: unique(`${dir}${safe(f.name)}${ext && !f.name.toLowerCase().endsWith(ext) ? ext : ''}`) });
    };
    for (const id of ids) {
      const f = loadFile(id, req.user);
      if (f.trashed) continue;
      add(q('SELECT id, name, kind, size, storage, content, mime FROM files WHERE id = ?').get(f.id), '');
    }
    const zip = new JSZip();
    for (const e of entries) {
      if (e.folder) { zip.folder(e.path); continue; }
      const { f } = e;
      if (f.kind === 'file') zip.file(e.path, fs.createReadStream(path.join(FILES_DIR, f.storage)), { binary: true });
      else {
        const content = JSON.parse(f.content || '{}');
        const pictureData = async (fileId) => {
          const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
          if (!pic || !/^image\//.test(pic.mime || '') || !atLeast(roleFor(f.id, pic.owner_id), 'editor')) return null;
          return { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime };
        };
        const buf = f.kind === 'doc' ? await wordFromDoc(content, f.name, { pictureData, page: setupOf(f) }) : f.kind === 'sheet' ? await excelFromSheet(content) : await powerPointFromDeck(content, { title: f.name, pictureData });
        zip.file(e.path, buf);
      }
    }
    const one = ids.length === 1 ? q('SELECT name FROM files WHERE id = ?').get(ids[0])?.name : null;
    const name = `${one ? safe(one) : 'Workspace files'}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' }).on('error', (err) => res.destroy(err)).pipe(res);
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
    if (!EMPTY[kind]) throw bad('kind must be doc, sheet or slides');
    const parentId = resolveParent(req.body.parent_id, req.user);
    const name = cleanName(req.body.name || { doc: 'Untitled document', sheet: 'Untitled spreadsheet', slides: 'Untitled presentation' }[kind]);
    const content = req.body.content !== undefined ? JSON.stringify(req.body.content) : EMPTY[kind]();
    const id = insertFile({ owner: req.user.id, parentId, name, kind, content, size: Buffer.byteLength(content) });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  // Raw streaming upload: POST /upload?parent=&name=  (body = file bytes)
  r.post('/upload', async (req, res) => {
    const parentId = resolveParent(req.query.parent, req.user);
    const name = cleanName(String(req.query.name || ''));
    const { storage, size } = await receiveUpload(req, req.user.org_id, maxUploadBytes);
    const id = insertFile({ owner: req.user.id, parentId, name, kind: 'file', mime: mimeFor(name), size, storage });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/empty-trash', (req, res) => {
    const ids = q('SELECT id FROM files WHERE owner_id = ? AND trashed = 1').all(req.user.id);
    tx(() => { for (const { id } of ids) permanentlyDelete(id); });
    if (ids.length) audit(req, 'trash.empty', { details: { items: ids.length } });
    res.json({ deleted: ids.length });
  });

  r.get('/:id', (req, res) => {
    res.json(publicFile(loadFile(req.params.id, req.user)));
  });

  // Star a file or folder (for you only), or take the star away.
  r.put('/:id/star', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (req.body?.starred) q('INSERT OR IGNORE INTO file_stars (user_id, file_id, created_at) VALUES (?, ?, ?)').run(req.user.id, f.id, now());
    else q('DELETE FROM file_stars WHERE user_id = ? AND file_id = ?').run(req.user.id, f.id);
    res.json({ starred: !!req.body?.starred });
  });

  // Make a copy of a file, document, spreadsheet or presentation, next to it if you can add files
  // there (otherwise in your Drive).
  r.post('/:id/copy', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind === 'folder') throw bad('Folders can’t be copied yet; copy the files in it');
    const row = q('SELECT * FROM files WHERE id = ?').get(f.id);
    const parentId = req.body?.parent_id !== undefined ? resolveParent(req.body.parent_id, req.user)
      : row.parent_id && atLeast(roleFor(row.parent_id, req.user.id) || '', 'editor') ? row.parent_id : null;
    checkQuota(req.user.org_id, row.size || 0);
    let storage = null;
    if (row.storage) { storage = uid(); fs.copyFileSync(path.join(FILES_DIR, row.storage), path.join(FILES_DIR, storage)); }
    const id = insertFile({ owner: req.user.id, parentId, name: `Copy of ${row.name}`, kind: row.kind, mime: row.mime, size: row.size, storage, content: row.content });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
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
    if (!EDITABLE.includes(f.kind)) throw bad('No editable content');
    const { content } = q('SELECT content FROM files WHERE id = ?').get(f.id);
    res.json({ file: publicFile(f), content: JSON.parse(content) });
  });

  // Save with optimistic concurrency: client sends the version it edited.
  r.put('/:id/content', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (!EDITABLE.includes(f.kind)) throw bad('No editable content');
    const json = JSON.stringify(req.body.content ?? null);
    // One earlier version per editing session: when someone else edited last, or after a pause.
    const cur = q('SELECT version, updated_at, updated_by, owner_id FROM files WHERE id = ?').get(f.id);
    const newSession = cur.version === Number(req.body.version) && cur.version > 1
      && ((cur.updated_by || cur.owner_id) !== req.user.id || now() - cur.updated_at > SESSION_MS);
    if (newSession) snapshot(f.id);
    const result = q(`UPDATE files SET content = ?, size = ?, version = version + 1, updated_at = ?, updated_by = ?
                      WHERE id = ? AND version = ?`)
      .run(json, Buffer.byteLength(json), now(), req.user.id, f.id, Number(req.body.version));
    if (!result.changes) {
      const cur = q('SELECT content, version FROM files WHERE id = ?').get(f.id);
      return res.status(409).json({ error: 'Someone else changed this file', version: cur.version, content: JSON.parse(cur.content) });
    }
    const version = f.version + 1;
    if (CO_EDITED.includes(f.kind)) resetRoom(f.id); // anyone co-editing reloads this version
    notify(f.id, { type: 'content-changed', id: f.id, version, by: req.user.id, by_name: req.user.name });
    res.json({ version });
  });

  r.patch('/:id', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const { name, parent_id, trashed } = req.body;
    // Page setup (documents): checked before anything changes.
    const setup = req.body.page_setup !== undefined && f.kind === 'doc' ? readSetup(req.body.page_setup) : undefined;
    if (req.body.page_setup !== undefined && f.kind !== 'doc') throw bad('Only documents have a page setup');
    const color = req.body.color !== undefined ? (req.body.color === null || req.body.color === '' ? null : /^#[0-9a-f]{6}$/i.test(String(req.body.color)) ? String(req.body.color).toLowerCase() : (() => { throw bad('Pick a colour like #1a73e8'); })()) : undefined;
    if (color !== undefined && f.kind !== 'folder') throw bad('Only folders have a colour');
    const description = req.body.description !== undefined ? (str(req.body.description ?? '', { max: 2000, name: 'Description' }) || null) : undefined;
    tx(() => {
      if (color !== undefined) q('UPDATE files SET color = ? WHERE id = ?').run(color, f.id);
      if (description !== undefined) q('UPDATE files SET description = ? WHERE id = ?').run(description, f.id);
      if (setup !== undefined) q('UPDATE files SET page_setup = ? WHERE id = ?').run(setup ? JSON.stringify(setup) : null, f.id);
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
      if (trashed !== undefined) q('UPDATE files SET trashed = ?, trashed_at = ?, updated_at = ? WHERE id = ?').run(trashed ? 1 : 0, trashed ? now() : null, now(), f.id);
    });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    if (setup !== undefined) notify(f.id, { type: 'page-setup', id: f.id, page_setup: setup });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  r.delete('/:id', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const audience = audienceFor(f.id);
    tx(() => permanentlyDelete(f.id));
    audit(req, 'file.delete', { target: f.name });
    sendTo(audience, { type: 'files-changed', parent_id: f.parent_id });
    res.json({ ok: true });
  });

  // Pictures in a presentation: anyone who can open the deck sees them, even if the picture file
  // itself isn't shared with them. Only pictures the deck uses, owned by someone who can edit it.
  r.get('/:id/pictures/:pic', (req, res) => {
    const deck = loadFile(req.params.id, req.user);
    if (deck.kind !== 'slides' && deck.kind !== 'doc') throw notFound();
    const pic = String(req.params.pic);
    const { content } = q('SELECT content FROM files WHERE id = ?').get(deck.id);
    const used = picturesIn(deck.kind, JSON.parse(content || '{}')).has(pic)
      // Just put in and not saved yet: the person who added it can see their own picture.
      || q("SELECT 1 FROM files WHERE id = ? AND owner_id = ?").get(pic, req.user.id);
    const f = used && q('SELECT * FROM files WHERE id = ? AND kind = ? AND trashed = 0').get(pic, 'file');
    if (!f || !/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mime || '') || !atLeast(roleFor(deck.id, f.owner_id), 'editor')) throw notFound('Picture not found');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  // Open a Word, Excel or PowerPoint file as a Docs, Sheets or Slides copy, next to it if you can
  // add files there (otherwise in your Drive). The original stays as it is.
  r.post('/:id/open-as', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    const type = f.kind === 'file' && officeType(f.name);
    if (!type) throw bad('Only Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files can be opened this way');
    if (f.size > MAX_CONVERT) throw bad('This file is too large to convert (50 MB at most)');
    const parentId = f.parent_id && atLeast(roleFor(f.parent_id, req.user.id), 'editor') ? f.parent_id : null;
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    const name = f.name.replace(/\.[a-z]+$/i, '');
    let content;
    let folder = null;
    // The document's or presentation's pictures go in a folder of their own beside it.
    const savePicture = async (pname, data, mime) => {
      folder ??= insertFile({ owner: req.user.id, parentId, name: `${name} pictures`, kind: 'folder' });
      checkQuota(req.user.org_id, data.length);
      const storage = uid();
      fs.writeFileSync(path.join(FILES_DIR, storage), data);
      return insertFile({ owner: req.user.id, parentId: folder, name: pname, kind: 'file', mime, size: data.length, storage });
    };
    try {
      if (type === 'docx') content = (await docFromWord(buf, { savePicture })).doc;
      else if (type === 'xlsx') content = await sheetFromExcel(buf);
      else content = await deckFromPowerPoint(buf, { savePicture });
    } catch (e) { throw bad(`This file couldn't be read as ${type === 'docx' ? 'a Word document' : type === 'xlsx' ? 'an Excel workbook' : 'a PowerPoint presentation'}`); }
    const json = JSON.stringify(content);
    const id = insertFile({ owner: req.user.id, parentId, name, kind: OFFICE[type].kind, content: json, size: Buffer.byteLength(json) });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  // Download a document, spreadsheet or presentation as Word, Excel or PowerPoint.
  r.get('/:id/export', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    const type = EXPORT_AS[f.kind];
    if (!type) throw bad('Only documents, spreadsheets and presentations can be downloaded this way');
    const content = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(f.id).content || '{}');
    // The same rule as showing pictures in the file: only pictures owned by someone who can edit it.
    const pictureData = async (fileId) => {
      const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
      if (!pic || !/^image\//.test(pic.mime || '') || !atLeast(roleFor(f.id, pic.owner_id), 'editor')) return null;
      return { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime };
    };
    let buf;
    if (type === 'docx') buf = await wordFromDoc(content, f.name, { pictureData, page: setupOf(f) });
    else if (type === 'xlsx') buf = await excelFromSheet(content);
    else buf = await powerPointFromDeck(content, { title: f.name, pictureData });
    res.setHeader('Content-Type', OFFICE[type].mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${f.name}.${type}`)}`);
    res.send(buf);
  });

  // ---- version history ----
  const versionOf = (f, vid) => {
    const v = q('SELECT * FROM file_versions WHERE id = ? AND file_id = ?').get(vid, f.id);
    if (!v) throw notFound('That version is no longer there');
    return v;
  };
  r.get('/:id/versions', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(q(`SELECT v.id, v.version, v.name, v.saved_at, v.size, v.label, u.name AS saved_by_name FROM file_versions v LEFT JOIN users u ON u.id = v.saved_by
                WHERE v.file_id = ? ORDER BY v.saved_at DESC, v.version DESC`).all(f.id));
  });

  // Replace an uploaded file with new bytes; the old ones become an earlier version.
  r.post('/:id/versions', async (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (f.kind !== 'file') throw bad('Only uploaded files take a new version this way');
    const owner = q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id);
    const { storage, size } = await receiveUpload(req, owner.org_id, maxUploadBytes);
    const name = req.query.name ? cleanName(String(req.query.name)) : f.name;
    tx(() => {
      snapshot(f.id);
      q('UPDATE files SET storage = ?, size = ?, mime = ?, name = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(storage, size, mimeFor(name), name === f.name ? f.name : uniqueName(f.parent_id, f.owner_id, name), now(), req.user.id, f.id);
    });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  // Name the file as it is now ("Sent to the client"); named versions are kept for good.
  r.post('/:id/versions/name', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const label = str(req.body.label, { required: true, name: 'Name', max: 100 });
    if (CO_EDITED.includes(f.kind)) saveNow(f.id); // what the editors have now
    const id = snapshot(f.id, label);
    notify(f.id, { type: 'versions-changed', id: f.id });
    res.status(201).json({ id, label });
  });
  // Name or rename an earlier version (empty: not named any more).
  r.patch('/:id/versions/:vid', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const v = versionOf(f, req.params.vid);
    const label = str(req.body.label ?? '', { max: 100, name: 'Name' }) || null;
    q('UPDATE file_versions SET label = ? WHERE id = ?').run(label, v.id);
    notify(f.id, { type: 'versions-changed', id: f.id });
    res.json({ id: v.id, label });
  });

  r.get('/:id/versions/:vid/raw', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    const v = versionOf(f, req.params.vid);
    if (!v.storage) throw bad('Not a binary file');
    const inline = req.query.download === undefined && isInlineSafe(v.mime);
    res.setHeader('Content-Type', inline ? v.mime : 'application/octet-stream');
    if (v.mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.name)}`);
    res.sendFile(path.join(FILES_DIR, v.storage), { headers: { 'Cache-Control': 'private, max-age=0' } });
  });
  r.get('/:id/versions/:vid/content', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    const v = versionOf(f, req.params.vid);
    if (v.content === null) throw bad('No editable content');
    res.json({ content: JSON.parse(v.content), saved_at: v.saved_at, name: v.name });
  });

  // Bring back an earlier version; what's there now is kept as a version too, so nothing is lost.
  r.post('/:id/versions/:vid/restore', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const v = versionOf(f, req.params.vid);
    let storage = null;
    if (v.storage) {
      const owner = q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id);
      checkQuota(owner.org_id, v.size);
      storage = uid();
      fs.copyFileSync(path.join(FILES_DIR, v.storage), path.join(FILES_DIR, storage));
    }
    tx(() => {
      snapshot(f.id);
      q('UPDATE files SET storage = COALESCE(?, storage), content = COALESCE(?, content), size = ?, mime = COALESCE(?, mime), version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(storage, v.content, v.size, v.mime, now(), req.user.id, f.id);
    });
    if (CO_EDITED.includes(f.kind)) resetRoom(f.id);
    const after = loadFile(f.id, req.user);
    // Open editors (yours included) load the restored content.
    notify(f.id, { type: 'content-changed', id: f.id, version: after.version, by: null, by_name: req.user.name });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    res.json(publicFile(after));
  });

  r.delete('/:id/versions/:vid', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const v = versionOf(f, req.params.vid);
    q('DELETE FROM file_versions WHERE id = ?').run(v.id);
    if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
    res.json({ ok: true });
  });

  r.get('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(q(`SELECT s.user_id, s.role, u.name, u.username, o.name AS org_name, (u.org_id != ?) AS external
                FROM shares s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                WHERE s.file_id = ? ORDER BY u.name`).all(req.user.org_id, f.id).map((s) => ({ ...s, external: !!s.external })));
  });

  // Replace the share list: [{ user_id, role }]
  r.put('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const list = Array.isArray(req.body.shares) ? req.body.shares : null;
    if (!list) throw bad('shares must be an array');
    const before = audienceFor(f.id);
    const had = new Set(q('SELECT user_id FROM shares WHERE file_id = ?').all(f.id).map((x) => x.user_id));
    tx(() => {
      q('DELETE FROM shares WHERE file_id = ?').run(f.id);
      for (const s of list) {
        if (!['viewer', 'editor'].includes(s.role)) throw bad('role must be viewer or editor');
        if (s.user_id === f.owner_id) continue;
        if (!canReach(req.user, s.user_id)) throw bad('You cannot share with that person (external sharing may be turned off)');
        q('INSERT INTO shares (file_id, user_id, role) VALUES (?, ?, ?)').run(f.id, s.user_id, s.role);
      }
    });
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    const nameOf = (id) => q('SELECT username FROM users WHERE id = ?').get(id)?.username || id;
    audit(req, 'file.share', { target: f.name, details: { with: list.map((x) => `${nameOf(x.user_id)} (${x.role})`) } });
    const added = list.filter((x) => !had.has(x.user_id) && x.user_id !== f.owner_id && x.user_id !== req.user.id);
    for (const x of added) bell([x.user_id], { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with you`, body: x.role === 'editor' ? 'You can edit' : 'You can view', link: openLink(f), actor: req.user.name });
    res.json({ ok: true });
  });

  return r;
}
