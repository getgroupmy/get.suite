import { withoutSuggestions } from '../office/suggestions.js';
import { sync as syncShares, setFileGroups, groupsOf } from '../groups.js';
import { recordActivity, activityOf } from '../fileactivity.js';
import { isWatching, setWatching } from '../filewatch.js';
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
import { canReach, checkQuota, orgStorageUsed } from '../tenancy.js';
import { resetRoom, CO_EDITED, saveNow } from '../collab.js';
import { docFromWord, wordFromDoc } from '../office/word.js';
import { sheetFromExcel, excelFromSheet } from '../office/excel.js';
import { deckFromPowerPoint, powerPointFromDeck } from '../office/powerpoint.js';
import { markdownFromDoc, docFromMarkdown } from '../office/markdown.js';

// Office files that open as Docs, Sheets and Slides (and download back in the same format).
const OFFICE = {
  docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  md: { kind: 'doc', mime: 'text/markdown; charset=utf-8' },
  markdown: { kind: 'doc', mime: 'text/markdown; charset=utf-8' },
};
const EXPORT_AS = { doc: 'docx', sheet: 'xlsx', slides: 'pptx' };
const MAX_CONVERT = 50 * 1024 * 1024;
const officeType = (name) => OFFICE[(/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase()] ? (/\.([a-z]+)$/i.exec(name)[1].toLowerCase()) : null;

// Company templates: documents, spreadsheets and presentations an admin has marked for everyone in the company to start from.
if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'template')) q('ALTER TABLE files ADD COLUMN template INTEGER NOT NULL DEFAULT 0').run();
// Locked: nobody can change the content until whoever locked it (or the owner) unlocks it.
for (const c of ['locked_by TEXT', 'locked_at INTEGER']) if (!q('PRAGMA table_info(files)').all().some((x) => x.name === c.split(' ')[0])) q(`ALTER TABLE files ADD COLUMN ${c}`).run();
const COLS = `f.id, f.locked_by, f.locked_at, (SELECT name FROM users WHERE id = f.locked_by) AS locked_by_name, f.owner_id, f.parent_id, f.name, f.kind, f.mime, f.size, f.version, f.trashed, f.trashed_at, f.page_setup, f.color, f.description, f.template, f.org_role,
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
q(`CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- viewer | editor: what they asked for
  message TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (file_id, user_id)
)`).run();
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

/** Throws when the file is locked (its content can't change). */
function notLocked(f) {
  if (f.locked_at) throw new HttpError(423, `${f.locked_by_name || 'Someone'} locked this file. Unlock it to make changes.`);
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

export function insertFile({ owner, parentId, name, kind, mime = null, size = 0, storage = null, content = null, activity = null }) {
  const id = uid();
  const t = now();
  q(`INSERT INTO files (id, owner_id, parent_id, name, kind, mime, size, storage, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, owner, parentId, uniqueName(parentId, owner, name), kind, mime, size, storage, content, t, t, owner);
  // Who made it (and how): activity = { by, action, details } when it isn't simply the owner creating it.
  recordActivity(id, activity && 'by' in activity ? activity.by : owner, activity?.action || (kind === 'file' ? 'upload' : 'create'), activity?.details || null, t);
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

/**
 * Give a file or folder (and everything in it the giver owns) to someone else. The new owner's own
 * shares on them go (they own them now); the giver keeps edit access unless `keepAccess` is false.
 */
export function transferOwnership(rootId, fromId, toId, { keepAccess = true } = {}) {
  const ids = q(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id)
                 SELECT id FROM files WHERE id IN (SELECT id FROM t) AND owner_id = ?`).all(rootId, fromId).map((r) => r.id);
  tx(() => {
    for (const id of ids) {
      q('UPDATE files SET owner_id = ? WHERE id = ?').run(toId, id);
      q('DELETE FROM shares WHERE file_id = ? AND user_id = ?').run(id, toId);
      q('DELETE FROM file_stars WHERE file_id = ? AND user_id = ?').run(id, fromId);
    }
    if (keepAccess) q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, 'editor', 'editor') ON CONFLICT(file_id, user_id) DO UPDATE SET role = 'editor', direct_role = 'editor'`).run(rootId, fromId);
    for (const id of ids) syncShares(id); // the new owner no longer needs a group's share
  });
  return ids.length;
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
      // Shared with you, and shared with everyone in your company (by someone else).
      rows = q(`SELECT ${COLS}, s.role ${FROM} JOIN shares s ON s.file_id = f.id
                WHERE s.user_id = ? AND f.trashed = 0 AND ${REACHABLE} ${ORDER}`).all(me, org, org);
      const ids = new Set(rows.map((f) => f.id));
      const company = q(`SELECT ${COLS}, f.org_role AS role ${FROM} WHERE f.org_role IS NOT NULL AND u.org_id = ? AND f.owner_id != ? AND f.trashed = 0 ${ORDER}`).all(org, me)
        .filter((f) => !ids.has(f.id)).map((f) => ({ ...f, role: roleFor(f.id, me) || f.role }));
      rows = [...rows, ...company];
    } else if (view === 'recent') {
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE COALESCE(s.role, f.org_role) END AS role ${FROM}
                LEFT JOIN shares s ON s.file_id = f.id AND s.user_id = ?
                WHERE (f.owner_id = ? OR s.user_id IS NOT NULL OR (f.org_role IS NOT NULL AND u.org_id = ?)) AND f.kind != 'folder' AND f.trashed = 0 AND ${REACHABLE}
                ORDER BY f.updated_at DESC LIMIT 50`).all(me, me, me, org, org, org);
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
      // Yours, what's shared with you or your company, and everything inside folders shared that way.
      rows = q(`WITH RECURSIVE acc(id) AS (
                  SELECT s2.file_id FROM shares s2 JOIN files f1 ON f1.id = s2.file_id WHERE s2.user_id = ? AND f1.trashed = 0
                  UNION SELECT f2.id FROM files f2 JOIN users u2 ON u2.id = f2.owner_id WHERE f2.org_role IS NOT NULL AND u2.org_id = ? AND f2.trashed = 0
                  UNION SELECT f3.id FROM files f3 JOIN acc ON f3.parent_id = acc.id WHERE f3.trashed = 0)
                SELECT ${COLS} ${FROM}
                WHERE (f.owner_id = ? OR f.id IN (SELECT id FROM acc)) AND f.trashed = 0
                  AND (f.name LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\' OR f.id IN (SELECT value FROM json_each(?))) AND ${REACHABLE}
                  ${extra.map((x) => `AND (${x})`).join(' ')}
                ${ORDER} LIMIT 200`).all(me, org, me, term, term, ids, org, org, ...args)
        .map((f) => ({ ...f, role: f.owner_id === me ? 'owner' : roleFor(f.id, me) })).filter((f) => f.role); // a trashed folder above, or sharing switched off between companies

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

  // Where your space goes: your files, their older versions, the trash, and the biggest items.
  r.get('/storage', (req, res) => {
    const me = req.user.id;
    const sum = (sql) => q(sql).get(me).n;
    const org = q('SELECT quota_mb FROM orgs WHERE id = ?').get(req.user.org_id);
    const largest = q(`SELECT f.id, f.name, f.kind, f.size, f.trashed, f.parent_id,
                         (SELECT COUNT(*) FROM file_versions v WHERE v.file_id = f.id) AS versions,
                         (SELECT COALESCE(SUM(v.size), 0) FROM file_versions v WHERE v.file_id = f.id) AS versions_size
                       FROM files f WHERE f.owner_id = ? AND f.kind != 'folder' ORDER BY f.size + versions_size DESC LIMIT 25`).all(me)
      .filter((f) => f.size + f.versions_size > 0).map((f) => ({ ...f, trashed: !!f.trashed }));
    res.json({
      files: sum('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND trashed = 0'),
      trash: sum('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND trashed = 1'),
      versions: sum('SELECT COALESCE(SUM(v.size), 0) AS n FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.owner_id = ?'),
      company: { used: orgStorageUsed(req.user.org_id), quota: org?.quota_mb ? org.quota_mb * 1024 * 1024 : null },
      largest,
    });
  });

  r.post('/folder', (req, res) => {
    const parentId = resolveParent(req.body.parent_id, req.user);
    const id = insertFile({ owner: req.user.id, parentId, name: cleanName(req.body.name), kind: 'folder' });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  // A folder path inside a folder (for uploading a whole folder): each level is found, if a folder of
  // that name is already there that you can add to, or made. { parent_id, path: ['Photos', '2026'] } → { id }.
  r.post('/folder-path', (req, res) => {
    const names = Array.isArray(req.body.path) ? req.body.path.map((n) => cleanName(n)) : [];
    if (!names.length || names.length > 32) throw bad('Give the folder path, at most 32 levels');
    let parentId = resolveParent(req.body.parent_id, req.user);
    const made = [];
    for (const name of names) {
      const there = parentId
        ? q("SELECT id FROM files WHERE parent_id = ? AND name = ? AND kind = 'folder' AND trashed = 0").all(parentId, name)
        : q("SELECT id FROM files WHERE parent_id IS NULL AND owner_id = ? AND name = ? AND kind = 'folder' AND trashed = 0").all(req.user.id, name);
      const usable = there.find((f) => atLeast(roleFor(f.id, req.user.id) || '', 'editor'));
      if (usable) { parentId = usable.id; continue; }
      const before = parentId;
      parentId = insertFile({ owner: req.user.id, parentId, name, kind: 'folder' });
      made.push(before);
    }
    for (const p of new Set(made)) if (p) notify(p, { type: 'files-changed', parent_id: p });
    res.json({ id: parentId, created: made.length });
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

  // Company templates, for New → From a template.
  r.get('/templates', (req, res) => {
    res.json(q(`SELECT f.id, f.name, f.kind, f.description, u.name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id
                WHERE f.template = 1 AND f.trashed = 0 AND u.org_id = ? ORDER BY f.kind, f.name COLLATE NOCASE`).all(req.user.org_id));
  });

  // ---- asking for access: someone with a link to a file they can't open asks its owner ----
  // The asker learns nothing about the file (not even that it exists) until the owner says yes.
  r.post('/:id/request-access', (req, res) => {
    const role = req.body.role === 'editor' ? 'editor' : 'viewer';
    const message = str(req.body.message ?? '', { max: 500, name: 'Message' }) || null;
    const f = q('SELECT id, name, kind, owner_id, trashed FROM files WHERE id = ?').get(String(req.params.id));
    if (f && roleFor(f.id, req.user.id)) throw bad('You can already open this');
    if (q('SELECT COUNT(*) AS n FROM access_requests WHERE user_id = ?').get(req.user.id).n >= 50) throw bad('You have asked for too many files; wait for answers first');
    // Sent (or quietly not, for a file that isn't there or an owner they can't reach): the answer is the same.
    if (f && !f.trashed && f.owner_id !== req.user.id && canReach(req.user, f.owner_id)) {
      const had = q('SELECT 1 FROM access_requests WHERE file_id = ? AND user_id = ?').get(f.id, req.user.id);
      q(`INSERT INTO access_requests (id, file_id, user_id, role, message, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id, user_id) DO UPDATE SET role = excluded.role, message = excluded.message, created_at = excluded.created_at`)
        .run(uid(), f.id, req.user.id, role, message, now());
      if (!had) bell([f.owner_id], { kind: 'share', title: `${req.user.name || req.user.username} asks to ${role === 'editor' ? 'edit' : 'view'} “${f.name}”`, body: message || 'Open the request to answer', link: '/drive?requests=1', actor: req.user.name });
      sendTo([f.owner_id], { type: 'access-requests' });
    }
    res.json({ ok: true });
  });

  // Requests for your files, newest first.
  r.get('/access-requests', (req, res) => {
    res.json(q(`SELECT a.id, a.role, a.message, a.created_at, f.id AS file_id, f.name AS file_name, f.kind AS file_kind, u.name AS user_name, u.username AS user_email
                FROM access_requests a JOIN files f ON f.id = a.file_id JOIN users u ON u.id = a.user_id
                WHERE f.owner_id = ? AND f.trashed = 0 ORDER BY a.created_at DESC`).all(req.user.id));
  });

  // Answer one: { approve, role } — yes shares the file with them (as asked, or as you choose); no just says so.
  r.post('/access-requests/:rid', (req, res) => {
    const a = q(`SELECT a.*, f.name AS file_name, f.kind AS file_kind, f.owner_id FROM access_requests a JOIN files f ON f.id = a.file_id WHERE a.id = ?`).get(String(req.params.rid));
    if (!a || a.owner_id !== req.user.id) throw notFound();
    const f = { id: a.file_id, name: a.file_name, kind: a.file_kind };
    if (req.body.approve) {
      const role = ['viewer', 'editor'].includes(req.body.role) ? req.body.role : a.role;
      if (!canReach(req.user, a.user_id)) throw bad('You can’t share with that person (external sharing may be turned off)');
      q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, ?, ?) ON CONFLICT(file_id, user_id) DO UPDATE SET direct_role = excluded.direct_role`).run(f.id, a.user_id, role, role);
      syncShares(f.id);
      const who = q('SELECT name FROM users WHERE id = ?').get(a.user_id)?.name || 'someone';
      recordActivity(f.id, req.user.id, 'share', { added: [`${who} (${role === 'editor' ? 'can edit' : 'can view'})`], removed: [] });
      audit(req, 'file.share', { target: f.name, details: { with: [`${q('SELECT username FROM users WHERE id = ?').get(a.user_id)?.username} (${role})`], request: true } });
      bell([a.user_id], { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with you`, body: role === 'editor' ? 'You can edit' : 'You can view', link: openLink(f), actor: req.user.name });
      sendTo([a.user_id], { type: 'files-changed', parent_id: null });
    } else {
      bell([a.user_id], { kind: 'share', title: `${req.user.name || req.user.username} didn’t give you access to “${f.name}”`, body: null, link: null, actor: req.user.name });
    }
    q('DELETE FROM access_requests WHERE id = ?').run(a.id);
    sendTo([req.user.id], { type: 'access-requests' });
    res.json({ ok: true });
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
  // ---- company templates ----
  // Mark a file as a company template (or not): a company admin, for a file of their company they can open.
  r.put('/:id/template', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!req.user.is_admin || q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id)?.org_id !== req.user.org_id) throw forbidden('Only a company admin can make company templates');
    if (!EDITABLE.includes(f.kind)) throw bad('Only documents, spreadsheets and presentations can be templates');
    q('UPDATE files SET template = ? WHERE id = ?').run(req.body.template ? 1 : 0, f.id);
    audit(req, req.body.template ? 'file.template' : 'file.untemplate', { target: f.name });
    res.json(publicFile(loadFile(f.id, req.user)));
  });
  // Start a new file from a company template (everyone in the company may, shared with them or not).
  r.post('/templates/:id/use', (req, res) => {
    const row = q('SELECT f.*, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ? AND f.template = 1 AND f.trashed = 0').get(String(req.params.id));
    if (!row || row.org_id !== req.user.org_id) throw notFound('Template not found');
    const parentId = resolveParent(req.body?.parent_id, req.user);
    checkQuota(req.user.org_id, row.size || 0);
    const name = req.body?.name ? cleanName(req.body.name) : row.name;
    const id = insertFile({ owner: req.user.id, parentId, name, kind: row.kind, size: row.size, content: row.content, activity: { action: 'copy', details: { from: `the template ${row.name}` } } });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/:id/copy', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind === 'folder') throw bad('Folders can’t be copied yet; copy the files in it');
    const row = q('SELECT * FROM files WHERE id = ?').get(f.id);
    const parentId = req.body?.parent_id !== undefined ? resolveParent(req.body.parent_id, req.user)
      : row.parent_id && atLeast(roleFor(row.parent_id, req.user.id) || '', 'editor') ? row.parent_id : null;
    checkQuota(req.user.org_id, row.size || 0);
    let storage = null;
    if (row.storage) { storage = uid(); fs.copyFileSync(path.join(FILES_DIR, row.storage), path.join(FILES_DIR, storage)); }
    const id = insertFile({ owner: req.user.id, parentId, name: `Copy of ${row.name}`, kind: row.kind, mime: row.mime, size: row.size, storage, content: row.content, activity: { action: 'copy', details: { from: row.name } } });
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
    notLocked(f);
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
    recordActivity(f.id, req.user.id, 'edit');
    if (CO_EDITED.includes(f.kind)) resetRoom(f.id); // anyone co-editing reloads this version
    notify(f.id, { type: 'content-changed', id: f.id, version, by: req.user.id, by_name: req.user.name });
    res.json({ version });
  });

  // Lock or unlock: { locked }. Editors can lock; whoever locked it, or the owner, can unlock.
  r.put('/:id/lock', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (f.kind === 'folder') throw bad('Folders can\'t be locked');
    const locked = !!req.body?.locked;
    if (locked === !!f.locked_at) return res.json(publicFile(f));
    if (!locked && f.locked_by !== req.user.id && f.role !== 'owner') throw forbidden(`Only ${f.locked_by_name || 'whoever locked it'} or the owner can unlock it`);
    if (CO_EDITED.includes(f.kind)) saveNow(f.id); // keep what's being typed now
    q('UPDATE files SET locked_by = ?, locked_at = ? WHERE id = ?').run(locked ? req.user.id : null, locked ? now() : null, f.id);
    if (CO_EDITED.includes(f.kind)) resetRoom(f.id); // open editors reload, read-only or editable again
    recordActivity(f.id, req.user.id, locked ? 'lock' : 'unlock');
    const after = loadFile(f.id, req.user);
    notify(f.id, { type: 'file-locked', id: f.id, locked_at: after.locked_at, by_name: req.user.name });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    res.json(publicFile(after));
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
        if (n !== f.name) {
          const to = uniqueName(f.parent_id, f.owner_id, n);
          q('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(to, now(), f.id);
          recordActivity(f.id, req.user.id, 'rename', { from: f.name, to });
        }
      }
      if (parent_id !== undefined && parent_id !== f.parent_id) {
        if (parent_id === null) {
          if (f.role !== 'owner' || f.owner_id !== req.user.id) throw forbidden('Only the owner can move this to their root');
        } else {
          resolveParent(parent_id, req.user);
          if (subtreeIds(f.id).includes(parent_id)) throw bad('Cannot move a folder into itself');
        }
        q('UPDATE files SET parent_id = ? WHERE id = ?').run(parent_id, f.id);
        recordActivity(f.id, req.user.id, 'move', { to: parent_id ? q('SELECT name FROM files WHERE id = ?').get(parent_id)?.name : null });
      }
      if (trashed !== undefined && !!trashed !== !!f.trashed) {
        q('UPDATE files SET trashed = ?, trashed_at = ?, updated_at = ? WHERE id = ?').run(trashed ? 1 : 0, trashed ? now() : null, now(), f.id);
        recordActivity(f.id, req.user.id, trashed ? 'trash' : 'restore');
      }
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
    if (!type) throw bad('Only Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and Markdown (.md) files can be opened this way');
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
      else if (type === 'md' || type === 'markdown') content = docFromMarkdown(buf.toString('utf8'));
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
    const type = req.query.format === 'md' && f.kind === 'doc' ? 'md' : EXPORT_AS[f.kind];
    if (!type) throw bad('Only documents, spreadsheets and presentations can be downloaded this way');
    saveNow(f.id); // what's being typed right now goes in too
    const stored = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(f.id).content || '{}');
    const content = f.kind === 'doc' ? withoutSuggestions(stored) : stored; // pending suggestions aren't in it yet
    // The same rule as showing pictures in the file: only pictures owned by someone who can edit it.
    const pictureData = async (fileId) => {
      const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
      if (!pic || !/^image\//.test(pic.mime || '') || !atLeast(roleFor(f.id, pic.owner_id), 'editor')) return null;
      return { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime };
    };
    let buf;
    if (type === 'md') buf = Buffer.from(markdownFromDoc(content), 'utf8');
    else if (type === 'docx') buf = await wordFromDoc(content, f.name, { pictureData, page: setupOf(f) });
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
    notLocked(f);
    const owner = q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id);
    const { storage, size } = await receiveUpload(req, owner.org_id, maxUploadBytes);
    const name = req.query.name ? cleanName(String(req.query.name)) : f.name;
    tx(() => {
      snapshot(f.id);
      q('UPDATE files SET storage = ?, size = ?, mime = ?, name = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(storage, size, mimeFor(name), name === f.name ? f.name : uniqueName(f.parent_id, f.owner_id, name), now(), req.user.id, f.id);
    });
    recordActivity(f.id, req.user.id, 'edit'); // a new version uploaded (followers hear of it)
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
    notLocked(f);
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
    recordActivity(f.id, req.user.id, 'version', { saved_at: v.saved_at, label: v.label || null });
    const after = loadFile(f.id, req.user);
    // Open editors (yours included) load the restored content.
    notify(f.id, { type: 'content-changed', id: f.id, version: after.version, by: null, by_name: req.user.name });
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    res.json(publicFile(after));
  });

  // Free up space: all of a file's older versions go (named ones too). The file itself stays.
  r.delete('/:id/versions', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const list = q('SELECT id, size, storage FROM file_versions WHERE file_id = ?').all(f.id);
    q('DELETE FROM file_versions WHERE file_id = ?').run(f.id);
    for (const v of list) if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
    res.json({ deleted: list.length, freed: list.reduce((n, v) => n + v.size, 0) });
  });

  r.delete('/:id/versions/:vid', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const v = versionOf(f, req.params.vid);
    q('DELETE FROM file_versions WHERE id = ?').run(v.id);
    if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
    res.json({ ok: true });
  });

  // What happened to it, newest first (anyone who can open it sees this).
  r.get('/:id/activity', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(activityOf(f.id));
  });

  r.get('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(q(`SELECT s.user_id, s.direct_role, u.name, u.username, o.name AS org_name, (u.org_id != ?) AS external
                FROM shares s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                WHERE s.file_id = ? AND s.direct_role IS NOT NULL ORDER BY u.name`).all(req.user.org_id, f.id)
      .map(({ direct_role: role, ...s }) => ({ ...s, role, external: !!s.external })));
  });

  // Groups it's shared with: [{ group_id, role, name, members }]; the owner sets them ({ groups: [{ group_id, role }] }).
  r.get('/:id/groups', (req, res) => { const f = loadFile(req.params.id, req.user); res.json(groupsOf(f.id)); });
  r.put('/:id/groups', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const ownerOrg = q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id).org_id;
    const before = new Set(groupsOf(f.id).map((g) => g.group_id));
    const audienceBefore = audienceFor(f.id);
    const gained = setFileGroups(f.id, ownerOrg, req.body?.groups);
    sendTo(new Set([...audienceBefore, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    const now = groupsOf(f.id);
    const added = now.filter((g) => !before.has(g.group_id));
    if (added.length || before.size !== now.length - added.length) {
      recordActivity(f.id, req.user.id, 'share', { added: added.map((g) => `the group ${g.name} (${g.role === 'editor' ? 'can edit' : 'can view'})`), removed: [] });
      audit(req, 'file.share', { target: f.name, details: { groups: now.map((g) => `${g.name} (${g.role})`) } });
    }
    const fresh = gained.filter((id) => id !== req.user.id);
    if (fresh.length) bell(fresh, { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with ${added.length === 1 ? `the group ${added[0].name}` : 'a group you are in'}`, link: openLink(f), actor: req.user.name });
    res.json(now);
  });

  // Share with everyone in the company (the owner's), or stop: { role: 'viewer' | 'editor' | null }.
  // Follow a file: hear when someone else changes it.
  r.get('/:id/watch', (req, res) => { const f = loadFile(req.params.id, req.user); res.json({ watching: isWatching(req.user.id, f.id) }); });
  r.put('/:id/watch', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    setWatching(req.user.id, f.id, !!req.body.on);
    res.json({ watching: !!req.body.on });
  });

  // Someone was @mentioned in a document's text: tell them (once in 10 minutes for the same document
  // and person), or say they can't open it, and whether you could share it with them.
  const mentioned = new Map(); // `${file}:${from}:${to}` → when
  r.post('/:id/mention', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    const to = q('SELECT id, name, username FROM users WHERE id = ? AND disabled = 0').get(String(req.body.user_id || ''));
    if (!to || !canReach(req.user, to.id)) throw bad('Choose someone you can work with');
    if (to.id === req.user.id) return res.json({ notified: false });
    if (!roleFor(f.id, to.id)) return res.json({ notified: false, no_access: true, can_share: f.owner_id === req.user.id, name: to.name });
    const key = `${f.id}:${req.user.id}:${to.id}`;
    if (Date.now() - (mentioned.get(key) || 0) < 10 * 60e3) return res.json({ notified: false, recently: true });
    mentioned.set(key, Date.now());
    bell([to.id], { kind: 'mention', title: `${req.user.name || req.user.username} mentioned you in “${f.name}”`, body: null, link: openLink(f), actor: req.user.name });
    res.json({ notified: true, name: to.name });
  });

  // Before sending an email that links to Drive files: which of the colleagues it goes to can't open
  // which file ({ files: [ids], emails: [addresses] }). Files you can't open yourself are left out.
  r.post('/missing-access', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.files) ? req.body.files : []).map(String))].slice(0, 20);
    const emails = [...new Set((Array.isArray(req.body.emails) ? req.body.emails : []).map((e) => String(e).trim().toLowerCase()))].slice(0, 100);
    const people = emails.length ? q(`SELECT id, name, username FROM users WHERE disabled = 0 AND LOWER(username) IN (SELECT value FROM json_each(?))`).all(JSON.stringify(emails))
      .filter((u) => u.id !== req.user.id && canReach(req.user, u.id)) : [];
    const out = [];
    for (const id of ids) {
      const f = q('SELECT id, name, kind, owner_id FROM files WHERE id = ? AND trashed = 0').get(id);
      if (!f || !roleFor(f.id, req.user.id)) continue;
      const missing = people.filter((u) => !roleFor(f.id, u.id));
      if (missing.length) out.push({ id: f.id, name: f.name, kind: f.kind, can_share: f.owner_id === req.user.id, people: missing });
    }
    res.json(out);
  });

  // Who can open one file (?for=: a document linking to this one) but not this one: offered to share
  // when a link is put in. Only for someone who can open both; can_share says whether they own this one.
  r.get('/:id/missing-access', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    const host = loadFile(String(req.query.for || ''), req.user);
    const people = audienceFor(host.id).filter((u) => u !== req.user.id && !roleFor(f.id, u));
    const rows = people.length ? q(`SELECT id, name, username FROM users WHERE disabled = 0 AND id IN (SELECT value FROM json_each(?)) ORDER BY name`).all(JSON.stringify(people)) : [];
    res.json({ people: rows, can_share: f.owner_id === req.user.id });
  });

  // Make a colleague the owner (of a folder: with everything in it you own). You keep edit access.
  r.post('/:id/transfer', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    if (f.owner_id !== req.user.id) throw forbidden('Only the owner can give it to someone else');
    const to = q('SELECT id, name, org_id, disabled FROM users WHERE id = ?').get(String(req.body.user_id || ''));
    if (!to || to.disabled || to.org_id !== req.user.org_id) throw bad('Choose someone in your company');
    if (to.id === req.user.id) throw bad('You already own it');
    const before = audienceFor(f.id);
    const n = transferOwnership(f.id, req.user.id, to.id);
    recordActivity(f.id, req.user.id, 'transfer', { to: to.name });
    audit(req, 'file.transfer', { target: f.name, details: { to: q('SELECT username FROM users WHERE id = ?').get(to.id).username, items: n } });
    bell([to.id], { kind: 'share', title: `${req.user.name} made you the owner of “${f.name}”`, body: f.kind === 'folder' ? `${n} item${n === 1 ? '' : 's'}` : '', link: openLink(f), actor: req.user.name });
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    res.json({ ...publicFile(loadFile(f.id, req.user)), items: n });
  });

  r.put('/:id/company', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    if (f.owner_id !== req.user.id) throw forbidden('Only the owner can share with the whole company');
    const role = ['viewer', 'editor'].includes(req.body.role) ? req.body.role : null;
    const before = audienceFor(f.id);
    q('UPDATE files SET org_role = ? WHERE id = ?').run(role, f.id);
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    const orgName = q('SELECT name FROM orgs WHERE id = ?').get(req.user.org_id)?.name || 'the company';
    recordActivity(f.id, req.user.id, 'share', role ? { added: [`everyone at ${orgName} (${role === 'editor' ? 'can edit' : 'can view'})`], removed: [] } : { added: [], removed: [`everyone at ${orgName}`] });
    audit(req, 'file.share', { target: f.name, details: { with: [role ? `everyone (${role})` : 'no longer everyone'] } });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  // Replace the share list: [{ user_id, role }]
  r.put('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    const list = Array.isArray(req.body.shares) ? req.body.shares : null;
    if (!list) throw bad('shares must be an array');
    const before = audienceFor(f.id);
    const had = new Set(q('SELECT user_id FROM shares WHERE file_id = ? AND direct_role IS NOT NULL').all(f.id).map((x) => x.user_id));
    tx(() => {
      // People shared with one by one; access through groups is worked out again after (syncShares).
      q('UPDATE shares SET direct_role = NULL WHERE file_id = ?').run(f.id);
      for (const s of list) {
        if (!['viewer', 'editor'].includes(s.role)) throw bad('role must be viewer or editor');
        if (s.user_id === f.owner_id) continue;
        if (!canReach(req.user, s.user_id)) throw bad('You cannot share with that person (external sharing may be turned off)');
        q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, ?, ?)
           ON CONFLICT(file_id, user_id) DO UPDATE SET direct_role = excluded.direct_role`).run(f.id, s.user_id, s.role, s.role);
      }
      syncShares(f.id);
    });
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    for (const x of list) q('DELETE FROM access_requests WHERE file_id = ? AND user_id = ?').run(f.id, x.user_id); // asked, and now has it
    const nameOf = (id) => q('SELECT username FROM users WHERE id = ?').get(id)?.username || id;
    audit(req, 'file.share', { target: f.name, details: { with: list.map((x) => `${nameOf(x.user_id)} (${x.role})`) } });
    const added = list.filter((x) => !had.has(x.user_id) && x.user_id !== f.owner_id && x.user_id !== req.user.id);
    const gone = [...had].filter((id) => !list.some((x) => x.user_id === id));
    const who = (id) => q('SELECT name FROM users WHERE id = ?').get(id)?.name || 'someone';
    if (added.length || gone.length) recordActivity(f.id, req.user.id, 'share', { added: added.map((x) => `${who(x.user_id)} (${x.role === 'editor' ? 'can edit' : 'can view'})`), removed: gone.map(who) });
    for (const x of added) bell([x.user_id], { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with you`, body: x.role === 'editor' ? 'You can edit' : 'You can view', link: openLink(f), actor: req.user.name });
    res.json({ ok: true });
  });

  return r;
}
