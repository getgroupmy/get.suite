import { withoutSuggestions } from '../office/suggestions.js';
import { combine, extract, parsePages, pageCount, typeOf, stamp, organize, MAX_PAGES as MAX_PDF_PAGES } from '../pdftools.js';
import { filesFor, fileRulesStop } from '../dlp.js';
import crypto from 'node:crypto';
import { sync as syncShares, setFileGroups, groupsOf } from '../groups.js';
import { MAX_SHARE_DAYS } from '../shareexpiry.js';
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
import { contentMatches, indexSoon, docText } from '../search.js';
import { countText, readingMinutes } from '../wordcount.js';
import { readSetup } from '../pagesetup.js';
import JSZip from 'jszip';
import { uid, now, str, bad, forbidden, notFound, HttpError, mimeFor, isInlineSafe } from '../util.js';
import { keepIfHeld, onHold } from '../hold.js';
import { roleFor, atLeast, audienceFor, subtreeIds, mayTakeAway } from '../access.js';
import { sendTo } from '../hub.js';
import { canReach, checkQuota, orgStorageUsed, userStorageUsed } from '../tenancy.js';
import { resetRoom, CO_EDITED, saveNow } from '../collab.js';
import { docFromWord, wordFromDoc, watermarkOfWord, layoutOfWord, pageOfWord } from '../office/word.js';
import { sheetFromExcel, excelFromSheet, commentsOfBook } from '../office/excel.js';
import { deckFromPowerPoint, powerPointFromDeck, commentsOfDeck } from '../office/powerpoint.js';
import { officePreview, officeKind, MAX_PREVIEW } from '../office/preview.js';
import { odtFromDoc, docFromOdt, ODT_MIME } from '../office/odt.js';
import { odsFromSheet, sheetFromOds, ODS_MIME } from '../office/ods.js';
import { odpFromDeck, deckFromOdp, ODP_MIME } from '../office/odp.js';
import { cellHistory } from '../office/cellhistory.js';
import { zipEntries, extractZip } from '../zipfiles.js';
import { markdownFromDoc, docFromMarkdown } from '../office/markdown.js';
import { parseCsv } from '../contactfiles.js';
import { brokenProtections } from '../sheetprotect.js';

// Office files that open as Docs, Sheets and Slides (and download back in the same format).
const OFFICE = {
  docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  odt: { kind: 'doc', mime: ODT_MIME },
  ods: { kind: 'sheet', mime: ODS_MIME },
  odp: { kind: 'slides', mime: ODP_MIME },
  md: { kind: 'doc', mime: 'text/markdown; charset=utf-8' },
  markdown: { kind: 'doc', mime: 'text/markdown; charset=utf-8' },
};
const EXPORT_AS = { doc: 'docx', sheet: 'xlsx', slides: 'pptx' };
const MAX_CONVERT = 50 * 1024 * 1024;
const officeType = (name) => OFFICE[(/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase()] ? (/\.([a-z]+)$/i.exec(name)[1].toLowerCase()) : null;

// Company templates: documents, spreadsheets and presentations an admin has marked for everyone in the company to start from.
if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'template')) q('ALTER TABLE files ADD COLUMN template INTEGER NOT NULL DEFAULT 0').run();
// no_download: people who can only view or comment can't download, export, copy or sync it (see mayTakeAway).
if (!q('PRAGMA table_info(files)').all().some((x) => x.name === 'no_download')) q('ALTER TABLE files ADD COLUMN no_download INTEGER NOT NULL DEFAULT 0').run();
const NO_TAKING = 'The owner has turned off downloading, printing and copying for people who can only view it';
// Locked: nobody can change the content until whoever locked it (or the owner) unlocks it.
for (const c of ['locked_by TEXT', 'locked_at INTEGER']) if (!q('PRAGMA table_info(files)').all().some((x) => x.name === c.split(' ')[0])) q(`ALTER TABLE files ADD COLUMN ${c}`).run();
const COLS = `f.id, f.is_drive, f.no_download, f.locked_by, f.locked_at, (SELECT name FROM users WHERE id = f.locked_by) AS locked_by_name, f.owner_id, f.parent_id, f.name, f.kind, f.mime, f.size, f.version, f.trashed, f.trashed_at, f.page_setup, f.color, f.description, f.template, f.org_role,
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
/** A spreadsheet's open comment threads on cells, for its Excel download: [{ sheet, cell, author, at, text, replies }]. */
function cellCommentsOf(fileId) {
  return wordCommentsOf(fileId).map((t) => { let a = {}; try { a = JSON.parse(q('SELECT anchor FROM file_comments WHERE id = ?').get(t.id)?.anchor || '{}'); } catch { /* none */ } return a.cell && !a.gone ? { ...t, sheet: a.sheet || 0, cell: a.cell } : null; }).filter(Boolean);
}
/** A presentation's open comment threads, for its PowerPoint download: [{ slideId, author, at, text, replies }]. */
function slideCommentsOf(fileId) {
  return wordCommentsOf(fileId).map((t) => ({ ...t, slideId: (() => { try { return JSON.parse(q('SELECT anchor FROM file_comments WHERE id = ?').get(t.id)?.anchor || '{}').slide; } catch { return null; } })() })).filter((t) => t.slideId);
}
/** A document's open comment threads, for its Word download: [{ id, author, at, text, replies }]. */
function wordCommentsOf(fileId) {
  const rows = q(`SELECT c.id, c.thread_id, c.body, c.created_at, u.name AS author FROM file_comments c LEFT JOIN users u ON u.id = c.author_id
                  WHERE c.file_id = ? AND (c.thread_id IS NOT NULL OR c.resolved = 0) ORDER BY c.created_at`).all(fileId);
  const threads = new Map();
  for (const r of rows) if (!r.thread_id) threads.set(r.id, { id: r.id, author: r.author || 'Former user', at: r.created_at, text: r.body, replies: [] });
  for (const r of rows) if (r.thread_id && threads.has(r.thread_id)) threads.get(r.thread_id).replies.push({ author: r.author || 'Former user', at: r.created_at, text: r.body });
  return [...threads.values()];
}
const setupOf = (f) => { if (!f.page_setup || typeof f.page_setup === 'object') return f.page_setup || null; try { return JSON.parse(f.page_setup); } catch { return null; } };

/** A column's letters: 0 → A, 26 → AA. */
const colLetters = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

export function cleanName(name) {
  const n = str(name, { required: true, name: 'Name', max: 255 });
  if (/[\/\\\0]/.test(n) || n === '.' || n === '..') throw bad('Name contains invalid characters');
  return n;
}

// Shared drives: a top-level folder that belongs to a team rather than a person. Its members are who
// it's shared with (people, groups, everyone in the company); those who can edit it also manage it
// (add and remove members, rename it), and what's in it stays when the person who added it leaves.
if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'is_drive')) q('ALTER TABLE files ADD COLUMN is_drive INTEGER NOT NULL DEFAULT 0').run();

/** The shared drive a file is in (its top folder, when that is a shared drive), or null. */
function driveOf(fileId) {
  let cur = q('SELECT id, parent_id, is_drive, name FROM files WHERE id = ?').get(fileId);
  for (let d = 0; cur?.parent_id && d < 64; d++) cur = q('SELECT id, parent_id, is_drive, name FROM files WHERE id = ?').get(cur.parent_id);
  return cur?.is_drive && cur.id !== fileId ? cur : null;
}

/** A file whose sharing you may change: yours, or a shared drive you can edit. */
function loadManaged(id, user) {
  const f = loadFile(id, user);
  if (f.role === 'owner' || (f.is_drive && !f.parent_id && atLeast(f.role, 'editor'))) return f;
  throw forbidden('Only the owner can change who has access');
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

/** Refuse replacing a spreadsheet's content with `next` (JSON text) if it changes ranges protected from this person. */
function protectionsKept(f, next, user) {
  if (f.kind !== 'sheet') return;
  saveNow(f.id);
  const cur = q('SELECT content FROM files WHERE id = ?').get(f.id)?.content;
  let before, after;
  try { before = JSON.parse(cur || '{}'); after = JSON.parse(next || '{}'); } catch { return; }
  const broken = brokenProtections(before, after, user.id, f.owner_id);
  if (broken.length) {
    const { p, sheet } = broken[0];
    throw forbidden(`${p.range ? `${sheet}!${p.range}` : `The sheet “${sheet}”`} is protected${p.desc ? ` (${p.desc})` : ''}. Ask the owner if you need to change it.`);
  }
}

/** Throws when the file is locked (its content can't change). */
function notLocked(f) {
  if (f.locked_at) throw new HttpError(423, `${f.locked_by_name || 'Someone'} locked this file. Unlock it to make changes.`);
}

// Who has opened a file: the last time and how many times, per person (shown to its owner and editors).
q(`CREATE TABLE IF NOT EXISTS file_views (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL,
  times INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (file_id, user_id)
)`).run();
// Off for a company (orgs.view_history = 0), or for a person who'd rather not be listed (users.hide_views).
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'view_history')) q('ALTER TABLE orgs ADD COLUMN view_history INTEGER NOT NULL DEFAULT 1').run();
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'hide_views')) q('ALTER TABLE users ADD COLUMN hide_views INTEGER NOT NULL DEFAULT 0').run();
const historyOn = (fileId) => !!q('SELECT o.view_history FROM files f JOIN users u ON u.id = f.owner_id JOIN orgs o ON o.id = u.org_id WHERE f.id = ?').get(fileId)?.view_history;
/** Count an opening (several within ten minutes count once). */
export function sawFile(fileId, userId, t = now()) {
  if (q('SELECT hide_views FROM users WHERE id = ?').get(userId)?.hide_views || !historyOn(fileId)) return;
  q(`INSERT INTO file_views (file_id, user_id, last_at, times) VALUES (?, ?, ?, 1)
     ON CONFLICT(file_id, user_id) DO UPDATE SET times = times + (CASE WHEN ? - last_at > 600000 THEN 1 ELSE 0 END), last_at = ?`).run(fileId, userId, t, t, t);
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
                 WHERE f.trashed = 1 AND o.trash_days > 0 AND u.legal_hold = 0 AND COALESCE(f.trashed_at, f.updated_at) < ? - o.trash_days * 86400000`).all(at);
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
  return tx(() => {
    const n = moveOwnership(rootId, fromId, toId);
    if (keepAccess) q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, 'editor', 'editor') ON CONFLICT(file_id, user_id) DO UPDATE SET role = 'editor', direct_role = 'editor'`).run(rootId, fromId);
    return n;
  });
}

/** What fromId owns in a folder (and the folder, if theirs) becomes toId's. Call inside a transaction. */
function moveOwnership(rootId, fromId, toId) {
  const ids = q(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id)
                 SELECT id FROM files WHERE id IN (SELECT id FROM t) AND owner_id = ?`).all(rootId, fromId).map((r) => r.id);
  for (const id of ids) {
    q('UPDATE files SET owner_id = ? WHERE id = ?').run(toId, id);
    q('DELETE FROM shares WHERE file_id = ? AND user_id = ?').run(id, toId);
    q('DELETE FROM file_stars WHERE file_id = ? AND user_id = ?').run(id, fromId);
  }
  for (const id of ids) syncShares(id); // the new owner no longer needs a group's share
  return ids.length;
}

/**
 * Someone is leaving (their account is being deleted): what they added to shared drives stays there.
 * A drive of theirs goes, with everything of theirs in it, to one of its members who can edit (or to
 * `heirId`, or, while others are still in it, to `adminId`, who is deleting the account, so it's never
 * lost with them); their files in others' drives go to each drive's owner. Returns how many items stayed.
 */
export function keepDriveFiles(userId, heirId = null, adminId = null) {
  const org = q('SELECT org_id FROM users WHERE id = ?').get(userId)?.org_id;
  return tx(() => {
    let n = 0;
    for (const d of q('SELECT id, owner_id FROM files WHERE is_drive = 1').all()) {
      if (d.owner_id === userId) {
        const next = q(`SELECT s.user_id FROM shares s JOIN users x ON x.id = s.user_id
                        WHERE s.file_id = ? AND s.role = 'editor' AND x.disabled = 0 AND x.id != ? AND x.org_id = ?
                        ORDER BY s.direct_role IS NULL, x.created_at LIMIT 1`).get(d.id, userId, org)?.user_id || heirId
          || (adminId && adminId !== userId && audienceFor(d.id).some((id) => id !== userId) ? adminId : null);
        if (next) n += moveOwnership(d.id, userId, next);
      } else if (q('SELECT 1 FROM files WHERE owner_id = ? AND id IN (' + SUBTREE + ')').get(userId, d.id)) {
        n += moveOwnership(d.id, userId, d.owner_id);
      }
    }
    return n;
  });
}
const SUBTREE = 'WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id) SELECT id FROM t';

/** Stream an upload into storage, within the size limit and the company's quota. */
export async function receiveUpload(req, orgId, maxUploadBytes, ownerId = null) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxUploadBytes) throw new HttpError(413, 'File is too large');
  checkQuota(orgId, declared, ownerId);
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
    checkQuota(orgId, size, ownerId); // Content-Length can be absent (chunked uploads)
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
  if (kind === 'slides' && typeof content.master?.logo === 'string' && content.master.logo) ids.add(content.master.logo); // the logo on every slide
  if (kind === 'slides') for (const sl of content.slides || []) {
    if (typeof sl.bgImage === 'string' && sl.bgImage) ids.add(sl.bgImage); // a picture behind the slide
    for (const it of sl.items || []) { if ((it.type === 'image' || it.type === 'video') && it.fileId) ids.add(it.fileId); } // pictures and videos
  }
  if (kind === 'doc') {
    const walk = (n) => { if (n?.type === 'image' && n.attrs?.fileId) ids.add(n.attrs.fileId); for (const c of n?.content || []) walk(c); };
    walk(content);
  }
  if (kind === 'sheet') { // =IMAGE("drive:<id>", …) in a cell
    for (const sh of content.sheets || []) for (const v of Object.values(sh.cells || {})) {
      if (typeof v !== 'string' || !/^=\s*IMAGE\s*\(/i.test(v)) continue;
      for (const m of v.matchAll(/"drive:([A-Za-z0-9_-]{4,64})"/g)) ids.add(m[1]);
    }
  }
  return ids;
}

q(`CREATE TABLE IF NOT EXISTS file_stars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
)`).run();
// Shortcuts: a file or folder shown in another folder (or your My Drive) without moving or copying
// it. Each person still needs access to what it points to; a shortcut to something they can't open
// isn't listed for them (only its maker sees it, so they can remove it).
q(`CREATE TABLE IF NOT EXISTS file_shortcuts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS file_shortcuts_parent ON file_shortcuts(parent_id, owner_id)').run();
const MAX_SHORTCUTS = 500;

/** The shortcuts in a folder (or a person's My Drive), as the files they point to, for this person. */
function shortcutsIn(parentId, user) {
  const rows = parentId ? q('SELECT * FROM file_shortcuts WHERE parent_id = ? ORDER BY created_at').all(parentId)
    : q('SELECT * FROM file_shortcuts WHERE parent_id IS NULL AND owner_id = ? ORDER BY created_at').all(user.id);
  const out = [];
  for (const s of rows) {
    const t = q(`SELECT ${COLS} ${FROM} WHERE f.id = ?`).get(s.target_id);
    const role = t && !t.trashed && roleFor(t.id, user.id);
    const mayRemove = s.owner_id === user.id || (parentId && atLeast(roleFor(parentId, user.id), 'editor'));
    if (role) out.push({ ...publicFile(t, role), shortcut_id: s.id, shortcut_parent: s.parent_id, shortcut_removable: !!mayRemove });
    else if (s.owner_id === user.id) out.push({ id: s.id, shortcut_id: s.id, shortcut_parent: s.parent_id, shortcut_removable: true, broken: true, kind: 'file', name: 'Shortcut to something you can no longer open', owner_id: user.id, updated_at: s.created_at, size: 0 });
  }
  return out;
}
const MAX_ZIP_BYTES = 2 * 1024 ** 3, MAX_ZIP_FILES = 20000;
// Content fingerprints, by stored file (stored files never change: a new version is a new one).
q('CREATE TABLE IF NOT EXISTS file_hashes (storage TEXT PRIMARY KEY, sha256 TEXT NOT NULL)').run();
const DUPLICATE_READ_BYTES = 4 * 1024 ** 3;
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

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
        rows = q(`SELECT ${COLS} ${FROM} WHERE f.owner_id = ? AND f.parent_id IS NULL AND f.is_drive = 0 AND f.trashed = 0 ${ORDER}`)
          .all(me).map((f) => publicFile(f, 'owner'));
      }
    } else if (view === 'shared') {
      // Shared with you, and shared with everyone in your company (by someone else).
      rows = q(`SELECT ${COLS}, s.role ${FROM} JOIN shares s ON s.file_id = f.id
                WHERE s.user_id = ? AND f.trashed = 0 AND f.is_drive = 0 AND ${REACHABLE} ${ORDER}`).all(me, org, org);
      const ids = new Set(rows.map((f) => f.id));
      const company = q(`SELECT ${COLS}, f.org_role AS role ${FROM} WHERE f.org_role IS NOT NULL AND u.org_id = ? AND f.owner_id != ? AND f.trashed = 0 AND f.is_drive = 0 ${ORDER}`).all(org, me)
        .filter((f) => !ids.has(f.id)).map((f) => ({ ...f, role: roleFor(f.id, me) || f.role }));
      rows = [...rows, ...company];
    } else if (view === 'drives') {
      // The shared drives you're a member of (or own), by name, with how many people are in each.
      rows = q(`SELECT ${COLS} ${FROM} WHERE f.is_drive = 1 AND f.trashed = 0 AND (u.org_id = ? OR f.id IN (SELECT file_id FROM shares WHERE user_id = ?)) AND ${REACHABLE} ORDER BY f.name COLLATE NOCASE`)
        .all(org, me, org, org).map((f) => ({ ...publicFile(f), role: f.owner_id === me ? 'owner' : roleFor(f.id, me) })).filter((f) => f.role)
        .map((f) => ({ ...f, members: audienceFor(f.id).length }));
    } else if (view === 'recent') {
      // Yours, and what you can open through sharing: shared with you or your company, and anything
      // inside folders and shared drives shared that way (a colleague's new file in the team drive).
      rows = q(`WITH RECURSIVE acc(id) AS (
                  SELECT s2.file_id FROM shares s2 JOIN files f1 ON f1.id = s2.file_id WHERE s2.user_id = ? AND f1.trashed = 0
                  UNION SELECT f2.id FROM files f2 JOIN users u2 ON u2.id = f2.owner_id WHERE f2.org_role IS NOT NULL AND u2.org_id = ? AND f2.trashed = 0
                  UNION SELECT f3.id FROM files f3 JOIN acc ON f3.parent_id = acc.id WHERE f3.trashed = 0)
                SELECT ${COLS} ${FROM}
                WHERE (f.owner_id = ? OR f.id IN (SELECT id FROM acc)) AND f.kind != 'folder' AND f.trashed = 0 AND ${REACHABLE}
                ORDER BY f.updated_at DESC LIMIT 80`).all(me, org, me, org, org)
        .map((f) => ({ ...f, role: f.owner_id === me ? 'owner' : roleFor(f.id, me) })).filter((f) => f.role).slice(0, 50); // a trashed folder above, or sharing switched off between companies
    } else if (view === 'starred') {
      rows = q(`SELECT ${COLS}, CASE WHEN f.owner_id = ? THEN 'owner' ELSE NULL END AS role ${FROM}
                JOIN file_stars st ON st.file_id = f.id AND st.user_id = ?
                WHERE f.trashed = 0 ${ORDER}`).all(me, me)
        .map((f) => ({ ...f, role: roleFor(f.id, me) })).filter((f) => f.role); // only what you can still open
    } else if (view === 'trash') {
      // With when each goes for good, when the company empties the trash after a while.
      const days = q('SELECT o.trash_days FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.id = ?').get(me)?.trash_days ?? 30;
      // Its owner on legal hold: kept until that's lifted.
      const goesFor = (f) => (onHold(f.owner_id) ? { kept: true } : days > 0 ? { deletes_at: (f.trashed_at || f.updated_at) + days * 864e5 } : {});
      rows = q(`SELECT ${COLS} ${FROM} WHERE f.owner_id = ? AND f.trashed = 1 ORDER BY f.trashed_at DESC, f.updated_at DESC`)
        .all(me).map((f) => ({ ...publicFile(f, 'owner'), ...goesFor(f) }));
      // And what anyone deleted in the shared drives you can edit: the drive's editors restore it or delete it for good.
      const mineIds = new Set(rows.map((f) => f.id));
      for (const d of q('SELECT id, name FROM files WHERE is_drive = 1 AND trashed = 0').all()) {
        if (!atLeast(roleFor(d.id, me), 'editor')) continue;
        const inside = q(`SELECT ${COLS} ${FROM} WHERE f.trashed = 1 AND f.id IN (SELECT value FROM json_each(?)) ORDER BY f.trashed_at DESC`).all(JSON.stringify(subtreeIds(d.id).filter((id) => id !== d.id)));
        for (const f of inside) if (!mineIds.has(f.id)) rows.push({ ...publicFile(f, f.owner_id === me ? 'owner' : 'editor'), drive_name: d.name, ...goesFor(f) });
        for (const f of rows) if (mineIds.has(f.id) && inside.some((x) => x.id === f.id)) f.drive_name = d.name;
      }
      rows.sort((a, b) => (b.trashed_at || 0) - (a.trashed_at || 0));
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
    // Shortcuts in this folder (or your My Drive), unless asked to leave them out.
    if (view === 'mine' && !req.query.noshortcuts) rows = [...rows, ...shortcutsIn(req.query.parent || null, req.user)];
    // Your stars on what's listed.
    const starred = new Set(q('SELECT file_id FROM file_stars WHERE user_id = ? AND file_id IN (SELECT value FROM json_each(?))').all(me, JSON.stringify(rows.map((f) => f.id))).map((x) => x.file_id));
    res.json(rows.map((f) => (starred.has(f.id) ? { ...f, starred: true } : f)));
  });

  // Download several files and folders as one .zip; documents, spreadsheets and presentations as
  // Word, Excel and PowerPoint files (or OpenDocument). Only what you can open, and not what's in the bin.
  r.get('/zip', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500);
    if (!ids.length) throw bad('Choose files to download');
    const entries = [];
    let total = 0;
    const used = new Set();
    // Documents, spreadsheets and presentations as Word, Excel and PowerPoint, or OpenDocument (?format=odf, or your choice in Settings).
    const odf = (req.query.format || q('SELECT file_format FROM users WHERE id = ?').get(req.user.id)?.file_format) === 'odf';
    const unique = (p) => { let n = p, i = 1; while (used.has(n.toLowerCase())) { const dot = p.lastIndexOf('.'); n = dot > p.lastIndexOf('/') ? `${p.slice(0, dot)} (${i})${p.slice(dot)}` : `${p} (${i})`; i++; } used.add(n.toLowerCase()); return n; };
    const safe = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'untitled';
    const add = (f, dir) => {
      if (entries.length >= MAX_ZIP_FILES) throw bad('Too many files for one download');
      if (f.kind === 'folder') {
        const here = unique(`${dir}${safe(f.name)}`);
        entries.push({ folder: true, path: `${here}/` });
        for (const c of q("SELECT id, name, kind, size, storage, content, mime, no_download FROM files WHERE parent_id = ? AND trashed = 0 ORDER BY name").all(f.id)) add(c, `${here}/`);
        return;
      }
      if (!mayTakeAway(f, roleFor(f.id, req.user.id))) return; // view only: left out
      if (f.kind === 'file') { total += f.size || 0; if (total > MAX_ZIP_BYTES) throw bad('More than 2 GB: download fewer files at a time'); }
      const ext = (odf ? { doc: '.odt', sheet: '.ods', slides: '.odp' } : { doc: '.docx', sheet: '.xlsx', slides: '.pptx' })[f.kind] || '';
      entries.push({ f, path: unique(`${dir}${safe(f.name)}${ext && !f.name.toLowerCase().endsWith(ext) ? ext : ''}`) });
    };
    for (const id of ids) {
      const f = loadFile(id, req.user);
      if (f.trashed) continue;
      add(q('SELECT id, name, kind, size, storage, content, mime, no_download FROM files WHERE id = ?').get(f.id), '');
    }
    const zip = new JSZip();
    for (const e of entries) {
      if (e.folder) { zip.folder(e.path); continue; }
      const { f } = e;
      if (f.kind === 'file') zip.file(e.path, fs.createReadStream(path.join(FILES_DIR, f.storage)), { binary: true });
      else zip.file(e.path, await exportedAs(q('SELECT * FROM files WHERE id = ?').get(f.id), odf ? { doc: 'odt', sheet: 'ods', slides: 'odp' }[f.kind] : EXPORT_AS[f.kind]));
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
  // Duplicate files: your files (not in the trash) with exactly the same content, whatever they're
  // called, biggest waste first. Only files of a size another file also has are read (and their
  // fingerprints kept), at most a few GB per look; { groups, incomplete } says if it stopped early.
  r.get('/duplicates', async (req, res) => {
    const same = q(`SELECT f.id, f.name, f.size, f.storage, f.parent_id, f.updated_at, p.name AS folder_name
                    FROM files f LEFT JOIN files p ON p.id = f.parent_id
                    WHERE f.owner_id = ? AND f.kind = 'file' AND f.trashed = 0 AND f.size > 0 AND f.storage IS NOT NULL
                      AND f.size IN (SELECT size FROM files WHERE owner_id = ? AND kind = 'file' AND trashed = 0 AND size > 0 GROUP BY size HAVING COUNT(*) > 1)
                    ORDER BY f.size DESC`).all(req.user.id, req.user.id);
    let budget = DUPLICATE_READ_BYTES, incomplete = false;
    const byHash = new Map();
    for (const f of same) {
      let hash = q('SELECT sha256 FROM file_hashes WHERE storage = ?').get(f.storage)?.sha256;
      if (!hash) {
        if (budget < f.size) { incomplete = true; continue; }
        budget -= f.size;
        try { hash = await hashFile(path.join(FILES_DIR, f.storage)); } catch { continue; }
        q('INSERT OR REPLACE INTO file_hashes (storage, sha256) VALUES (?, ?)').run(f.storage, hash);
      }
      const k = `${f.size}:${hash}`;
      byHash.set(k, [...(byHash.get(k) || []), { id: f.id, name: f.name, size: f.size, folder: f.parent_id ? { id: f.parent_id, name: f.folder_name } : null, updated_at: f.updated_at }]);
    }
    const groups = [...byHash.values()].filter((g) => g.length > 1)
      .map((files) => ({ size: files[0].size, wasted: files[0].size * (files.length - 1), files: files.sort((a, b) => b.updated_at - a.updated_at) }))
      .sort((a, b) => b.wasted - a.wasted).slice(0, 100);
    res.json({ groups, wasted: groups.reduce((n, g) => n + g.wasted, 0), incomplete });
  });

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
      mine: (() => { const mb = q('SELECT drive_quota_mb FROM users WHERE id = ?').get(me)?.drive_quota_mb; return { used: userStorageUsed(me), quota: mb ? mb * 1024 * 1024 : null }; })(),
      largest,
    });
  });

  // A new shared drive: { name }. You're its owner; add members with Share.
  r.post('/drives', (req, res) => {
    const id = insertFile({ owner: req.user.id, parentId: null, name: cleanName(req.body?.name), kind: 'folder' });
    q('UPDATE files SET is_drive = 1 WHERE id = ?').run(id);
    audit(req, 'drive.create', { target: q('SELECT name FROM files WHERE id = ?').get(id).name });
    res.status(201).json(publicFile(loadFile(id, req.user)));
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

  // PDF tools. Combine: { ids: [PDFs and PNG/JPEG pictures, in order], name?, parent_id? } → one new PDF.
  // Extract: { pages: '1-3, 5', rotate?: 90 | 180 | 270, name? } → a new PDF of those pages. The originals stay as they are.
  const pdfPart = (id, user) => {
    const f = loadFile(id, user);
    const type = f.kind === 'file' && f.storage ? typeOf(f) : null;
    if (!type) throw bad(`“${f.name}” isn’t a PDF or a PNG or JPEG picture`);
    if (!mayTakeAway(f, f.role)) throw forbidden(`“${f.name}” can’t be copied: its owner turned off downloading`);
    if (f.size > 100 * 1024 * 1024) throw bad(`“${f.name}” is too big (100 MB at most)`);
    return { f, type };
  };
  const savePdf = (req, bytes, name, parentId) => {
    checkQuota(req.user.org_id, bytes.length, req.user.id);
    const storage = uid();
    fs.writeFileSync(path.join(FILES_DIR, storage), bytes);
    const id = insertFile({ owner: req.user.id, parentId, name: cleanName(/\.pdf$/i.test(name) ? name : `${name}.pdf`), kind: 'file', mime: 'application/pdf', size: bytes.length, storage });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    sendTo([req.user.id], { type: 'files-changed', parent_id: parentId });
    return publicFile(loadFile(id, req.user));
  };
  /** Next to the first file when you can add there, else in your own Drive (or the folder asked for). */
  const placeFor = (req, f) => (req.body?.parent_id !== undefined ? resolveParent(req.body.parent_id, req.user) : f.parent_id && atLeast(roleFor(f.parent_id, req.user.id) || '', 'editor') ? f.parent_id : null);
  r.post('/pdf/combine', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
    if (ids.length < 1 || ids.length > 50) throw bad('Choose between 1 and 50 files');
    const parts = ids.map((id) => pdfPart(id, req.user));
    if (parts.reduce((n, p) => n + p.f.size, 0) > 300 * 1024 * 1024) throw bad('Together they’re too big (300 MB at most)');
    let bytes;
    try { bytes = await combine(parts.map((p) => ({ bytes: fs.readFileSync(path.join(FILES_DIR, p.f.storage)), type: p.type, name: p.f.name }))); } catch (e) { throw bad(e.message); }
    const first = parts[0].f;
    const out = savePdf(req, Buffer.from(bytes), String(req.body.name || '').trim() || `${first.name.replace(/\.[a-z0-9]+$/i, '')} (combined)`, placeFor(req, first));
    audit(req, 'pdf.combine', { target: out.name, details: { from: parts.map((p) => p.f.name) } });
    res.status(201).json(out);
  });
  r.get('/:id/pdf/pages', async (req, res) => {
    const { f, type } = pdfPart(req.params.id, req.user);
    if (type !== 'pdf') throw bad('That isn’t a PDF');
    try { res.json({ pages: await pageCount(fs.readFileSync(path.join(FILES_DIR, f.storage))) }); } catch { throw bad(`“${f.name}” couldn’t be read`); }
  });
  r.post('/:id/pdf/extract', async (req, res) => {
    const { f, type } = pdfPart(req.params.id, req.user);
    if (type !== 'pdf') throw bad('That isn’t a PDF');
    const turn = Number(req.body?.rotate || 0);
    if (![0, 90, 180, 270].includes(turn)) throw bad('Turn by 90, 180 or 270 degrees');
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    let count;
    try { count = await pageCount(buf); } catch { throw bad(`“${f.name}” couldn’t be read`); }
    const want = parsePages(req.body?.pages, count);
    if (want.error) throw bad(want.error);
    let bytes;
    try { bytes = await extract(buf, want.pages, turn); } catch { throw bad(`“${f.name}” couldn’t be read (is it password-protected?)`); }
    const base = f.name.replace(/\.pdf$/i, '');
    const out = savePdf(req, Buffer.from(bytes), String(req.body.name || '').trim() || `${base} (pages ${String(req.body.pages).replace(/\s+/g, '')})`, placeFor(req, f));
    audit(req, 'pdf.extract', { target: out.name, details: { from: f.name, pages: want.pages.length } });
    res.status(201).json(out);
  });

  // Fill & sign: { items: [{ page, x, y, w, h, png: 'data:image/png;base64,…' }], name? } → a signed copy.
  r.post('/:id/pdf/sign', async (req, res) => {
    const { f, type } = pdfPart(req.params.id, req.user);
    if (type !== 'pdf') throw bad('That isn’t a PDF');
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!list.length || list.length > 100) throw bad('Place between 1 and 100 things on the pages');
    const frac = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < -0.01 || n > 1.01) throw bad('Something is placed off the page'); return n; };
    const items = list.map((it) => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(it?.png || ''));
      if (!m) throw bad('Each thing placed must be a PNG picture');
      const png = Buffer.from(m[1], 'base64');
      if (png.length > 3 * 1024 * 1024) throw bad('A signature picture is too big');
      const w = frac(it.w), h = frac(it.h);
      if (!(w > 0 && h > 0)) throw bad('Something placed has no size');
      return { page: Math.trunc(Number(it.page)), x: frac(it.x), y: frac(it.y), w, h, png };
    });
    let bytes;
    try { bytes = await stamp(fs.readFileSync(path.join(FILES_DIR, f.storage)), items); } catch (e) { throw bad(/no page/.test(e.message) ? e.message : `“${f.name}” couldn’t be signed (is it password-protected?)`); }
    const out = savePdf(req, Buffer.from(bytes), String(req.body.name || '').trim() || `${f.name.replace(/\.pdf$/i, '')} (signed)`, placeFor(req, f));
    audit(req, 'pdf.sign', { target: out.name, details: { from: f.name, items: items.length } });
    res.status(201).json(out);
  });

  // Organise pages: { pages: [{ page (0-based), rotate }], as: 'version' | 'copy', name? }: reorder, turn and
  // leave out pages, saved as a new version of the PDF (editors; the old one is in its history) or a copy.
  r.post('/:id/pdf/organize', async (req, res) => {
    const asVersion = req.body?.as === 'version';
    const f = asVersion ? loadFile(req.params.id, req.user, 'editor') : pdfPart(req.params.id, req.user).f;
    if (typeOf(f) !== 'pdf' || f.kind !== 'file') throw bad('That isn’t a PDF');
    if (asVersion) notLocked(f);
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    let count;
    try { count = await pageCount(buf); } catch { throw bad(`“${f.name}” couldn’t be read`); }
    const list = Array.isArray(req.body?.pages) ? req.body.pages : [];
    if (!list.length) throw bad('Keep at least one page');
    if (list.length > MAX_PDF_PAGES) throw bad(`At most ${MAX_PDF_PAGES} pages`);
    const pages = list.map((x) => {
      const page = Math.trunc(Number(x?.page)), rotate = Number(x?.rotate || 0);
      if (!(page >= 0 && page < count)) throw bad(`This PDF has ${count} pages`);
      if (![0, 90, 180, 270].includes(rotate)) throw bad('Turn by 90, 180 or 270 degrees');
      return { page, rotate };
    });
    let bytes;
    try { bytes = Buffer.from(await organize(buf, pages)); } catch { throw bad(`“${f.name}” couldn’t be changed (is it password-protected?)`); }
    if (!asVersion) {
      const out = savePdf(req, bytes, String(req.body.name || '').trim() || `${f.name.replace(/\.pdf$/i, '')} (reorganised)`, placeFor(req, f));
      audit(req, 'pdf.organize', { target: out.name, details: { from: f.name, pages: pages.length } });
      return res.status(201).json(out);
    }
    const owner = q('SELECT id, org_id FROM users WHERE id = ?').get(f.owner_id);
    checkQuota(owner.org_id, bytes.length, owner.id);
    const storage = uid();
    fs.writeFileSync(path.join(FILES_DIR, storage), bytes);
    tx(() => {
      snapshot(f.id);
      q('UPDATE files SET storage = ?, size = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(storage, bytes.length, now(), req.user.id, f.id);
    });
    recordActivity(f.id, req.user.id, 'edit');
    notify(f.id, { type: 'files-changed', parent_id: f.parent_id });
    audit(req, 'pdf.organize', { target: f.name, details: { pages: pages.length, version: true } });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  // Raw streaming upload: POST /upload?parent=&name=  (body = file bytes)
  r.post('/upload', async (req, res) => {
    const parentId = resolveParent(req.query.parent, req.user);
    const name = cleanName(String(req.query.name || ''));
    const { storage, size } = await receiveUpload(req, req.user.org_id, maxUploadBytes, req.user.id);
    const id = insertFile({ owner: req.user.id, parentId, name, kind: 'file', mime: mimeFor(name), size, storage });
    // Uploaded in Drive (?convert=auto) by someone who chose to convert uploads: a Word, Excel, PowerPoint,
    // OpenDocument or Markdown file becomes a document, spreadsheet or presentation; the file goes to the trash.
    if (req.query.convert === 'auto' && officeType(name) && size <= MAX_CONVERT && q('SELECT convert_uploads FROM users WHERE id = ?').get(req.user.id)?.convert_uploads) {
      try {
        const made = await convertOffice(loadFile(id, req.user), req.user);
        q('UPDATE files SET trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
        recordActivity(id, req.user.id, 'trash');
        if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
        return res.status(201).json({ ...publicFile(loadFile(made, req.user)), converted_from: name });
      } catch (e) {
        if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
        return res.status(201).json({ ...publicFile(loadFile(id, req.user)), convert_error: e.message }); // kept as it came
      }
    }
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/empty-trash', (req, res) => {
    keepIfHeld(req.user.id, 'Your trash');
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
    const role = ['editor', 'commenter'].includes(req.body.role) ? req.body.role : 'viewer';
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
      const role = ['viewer', 'commenter', 'editor'].includes(req.body.role) ? req.body.role : a.role;
      if (!canReach(req.user, a.user_id)) throw bad('You can’t share with that person (external sharing may be turned off)');
      q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, ?, ?) ON CONFLICT(file_id, user_id) DO UPDATE SET direct_role = excluded.direct_role`).run(f.id, a.user_id, role, role);
      syncShares(f.id);
      const who = q('SELECT name FROM users WHERE id = ?').get(a.user_id)?.name || 'someone';
      recordActivity(f.id, req.user.id, 'share', { added: [`${who} (${role === 'editor' ? 'can edit' : role === 'commenter' ? 'can comment' : 'can view'})`], removed: [] });
      audit(req, 'file.share', { target: f.name, details: { with: [`${q('SELECT username FROM users WHERE id = ?').get(a.user_id)?.username} (${role})`], request: true } });
      bell([a.user_id], { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with you`, body: role === 'editor' ? 'You can edit' : role === 'commenter' ? 'You can comment' : 'You can view', link: openLink(f), actor: req.user.name });
      sendTo([a.user_id], { type: 'files-changed', parent_id: null });
    } else {
      bell([a.user_id], { kind: 'share', title: `${req.user.name || req.user.username} didn’t give you access to “${f.name}”`, body: null, link: null, actor: req.user.name });
    }
    q('DELETE FROM access_requests WHERE id = ?').run(a.id);
    sendTo([req.user.id], { type: 'access-requests' });
    res.json({ ok: true });
  });

  r.get('/:id', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (req.query.open !== undefined) sawFile(f.id, req.user.id); // opened in its editor
    res.json(publicFile(f));
  });

  // How big a folder is: everything in it, sub-folders too (not what's in the trash), how many files
  // and folders that is, and the biggest files in it.
  r.get('/:id/size', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'folder') throw bad('Only folders have contents');
    const inside = `WITH RECURSIVE t(id) AS (SELECT id FROM files WHERE parent_id = ? AND trashed = 0
                      UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id WHERE f.trashed = 0)`;
    const sum = q(`${inside} SELECT COALESCE(SUM(CASE WHEN f.kind != 'folder' THEN f.size END), 0) AS size,
                     COUNT(CASE WHEN f.kind != 'folder' THEN 1 END) AS files, COUNT(CASE WHEN f.kind = 'folder' THEN 1 END) AS folders
                   FROM files f JOIN t ON t.id = f.id`).get(f.id);
    const biggest = q(`${inside} SELECT f.id, f.name, f.kind, f.size FROM files f JOIN t ON t.id = f.id
                       WHERE f.kind != 'folder' AND f.size > 0 ORDER BY f.size DESC LIMIT 5`).all(f.id);
    res.json({ ...sum, biggest });
  });

  // Who has opened it (people with access, their last time and how many times): for its owner and editors.
  r.get('/:id/viewers', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (!historyOn(f.id)) return res.json({ off: true, viewers: [] });
    res.json({ off: false, viewers: q(`SELECT v.user_id AS id, u.name, u.username, v.last_at, v.times FROM file_views v JOIN users u ON u.id = v.user_id
                WHERE v.file_id = ? AND u.disabled = 0 AND u.hide_views = 0 ORDER BY v.last_at DESC LIMIT 200`).all(f.id).filter((v) => roleFor(f.id, v.id)) });
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
    checkQuota(req.user.org_id, row.size || 0, req.user.id);
    const name = req.body?.name ? cleanName(req.body.name) : row.name;
    const id = insertFile({ owner: req.user.id, parentId, name, kind: row.kind, size: row.size, content: row.content, activity: { action: 'copy', details: { from: `the template ${row.name}` } } });
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  r.post('/:id/copy', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!mayTakeAway(f, f.role)) throw forbidden(NO_TAKING);
    if (f.kind === 'folder') throw bad('Folders can’t be copied yet; copy the files in it');
    const row = q('SELECT * FROM files WHERE id = ?').get(f.id);
    const parentId = req.body?.parent_id !== undefined ? resolveParent(req.body.parent_id, req.user)
      : row.parent_id && atLeast(roleFor(row.parent_id, req.user.id) || '', 'editor') ? row.parent_id : null;
    checkQuota(req.user.org_id, row.size || 0, req.user.id);
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
      out.unshift({ id: cur.id, name: cur.name, ...(cur.is_drive && { is_drive: 1 }) });
      if (!cur.parent_id || !roleFor(cur.parent_id, req.user.id)) break;
      cur = q('SELECT id, name, parent_id, is_drive FROM files WHERE id = ?').get(cur.parent_id);
    }
    res.json(out);
  });

  r.get('/:id/raw', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'file') throw bad('Not a binary file');
    sawFile(f.id, req.user.id);
    const inline = req.query.download === undefined && isInlineSafe(f.mime);
    if (!inline && !mayTakeAway(f, f.role)) throw forbidden(NO_TAKING); // viewing in the browser only
    res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Lock down anything rendered on our origin (the PDF viewer needs default CSP to work).
    if (f.mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'private, max-age=0' } });
  });

  // A document, or a Word or Markdown file, as a document's content (TipTap JSON), for Docs' "Compare
  // documents": as it stands now, pending suggestions left out. Nothing is saved.
  r.get('/:id/as-doc', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind === 'doc') {
      saveNow(f.id); // what's being typed right now, too
      const { content } = q('SELECT content FROM files WHERE id = ?').get(f.id);
      return res.json({ name: f.name, content: withoutSuggestions(JSON.parse(content)) });
    }
    const type = f.kind === 'file' ? officeKind(f.name) : null;
    if (type !== 'docx' && type !== 'md' && type !== 'odt') throw bad('Only documents, Word, OpenDocument and Markdown files can be compared');
    if (f.size > MAX_PREVIEW) throw bad('This file is too large to compare (20 MB at most)');
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    let content;
    try { content = type === 'docx' ? (await docFromWord(buf)).doc : type === 'odt' ? (await docFromOdt(buf)).doc : docFromMarkdown(buf.toString('utf8')); }
    catch { throw bad("This file couldn't be read"); }
    res.json({ name: f.name, content });
  });

  // A spreadsheet, or an Excel or CSV file, as a spreadsheet's content, for Sheets' "Compare
  // spreadsheets": as it stands now. Nothing is saved.
  r.get('/:id/as-sheet', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind === 'sheet') {
      saveNow(f.id); // what's being typed right now, too
      const { content } = q('SELECT content FROM files WHERE id = ?').get(f.id);
      return res.json({ name: f.name, content: JSON.parse(content) });
    }
    const csv = f.kind === 'file' && /\.csv$/i.test(f.name);
    const ods = f.kind === 'file' && /\.ods$/i.test(f.name);
    if (!csv && !ods && !(f.kind === 'file' && /\.xlsx$/i.test(f.name))) throw bad('Only spreadsheets, Excel, OpenDocument and CSV files can be compared');
    if (f.size > MAX_PREVIEW) throw bad('This file is too large to compare (20 MB at most)');
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    let content;
    try {
      if (csv) {
        const cells = {};
        parseCsv(buf.toString('utf8'), { keepEmpty: true }).slice(0, 20000).forEach((row, r) => row.slice(0, 200).forEach((v, c) => { if (v !== '') cells[`${colLetters(c)}${r + 1}`] = v; }));
        content = { sheets: [{ name: f.name.replace(/\.csv$/i, '').slice(0, 100) || 'Sheet1', cells }] };
      } else content = ods ? await sheetFromOds(buf) : await sheetFromExcel(buf);
    } catch { throw bad("This file couldn't be read"); }
    res.json({ name: f.name, content });
  });

  // A Word, Excel, PowerPoint or Markdown file as a read-only document, spreadsheet or presentation (nothing is saved).
  r.get('/:id/preview', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'file' || !officeKind(f.name)) throw bad('This kind of file has no preview');
    if (f.size > MAX_PREVIEW) throw bad('This file is too large to preview (20 MB at most): download it instead');
    sawFile(f.id, req.user.id);
    res.json(await officePreview(fs.readFileSync(path.join(FILES_DIR, f.storage)), f.name, req.user.id));
  });

  // What's inside a zip file, and unpacking it into a folder next to it (or in your Drive).
  const isZip = (f) => f.kind === 'file' && /\.zip$/i.test(f.name);
  r.get('/:id/zip', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!isZip(f)) throw bad('Not a zip file');
    res.json(await zipEntries(fs.readFileSync(path.join(FILES_DIR, f.storage))));
  });
  r.post('/:id/extract', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!isZip(f)) throw bad('Not a zip file');
    if (!mayTakeAway(f, f.role)) throw forbidden(NO_TAKING);
    const parentId = f.parent_id && atLeast(roleFor(f.parent_id, req.user.id) || '', 'editor') ? f.parent_id : null;
    const owner = req.user.id;
    let done;
    try {
      done = await extractZip(fs.readFileSync(path.join(FILES_DIR, f.storage)), {
        rootName: f.name.replace(/\.zip$/i, '') || 'Unzipped', parentId,
        checkSpace: (bytes) => checkQuota(req.user.org_id, bytes, req.user.id),
        makeFolder: (name, parent) => insertFile({ owner, parentId: parent, name, kind: 'folder', activity: { action: 'create', details: { from: f.name } } }),
        makeFile: ({ name, parentId: parent, size, storage, mime }) => insertFile({ owner, parentId: parent, name, kind: 'file', mime, size, storage, activity: { action: 'upload', details: { from: f.name } } }),
      });
    } catch (e) {
      if (e.root) permanentlyDelete(e.root);
      for (const s of e.written || []) fs.rm(path.join(FILES_DIR, s), { force: true }, () => {});
      throw e;
    }
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.status(201).json({ folder: publicFile(loadFile(done.id, req.user)), files: done.files, folders: done.folders });
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
    protectionsKept(f, json, req.user);
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
    if (req.body.no_download !== undefined && f.role !== 'owner') throw forbidden('Only the owner can change who may download it');
    if (req.body.no_download !== undefined && f.kind === 'folder') throw bad('Set this on files, not folders');
    tx(() => {
      if (req.body.no_download !== undefined) {
        q('UPDATE files SET no_download = ? WHERE id = ?').run(req.body.no_download ? 1 : 0, f.id);
        recordActivity(f.id, req.user.id, 'share', { added: [], removed: [], note: req.body.no_download ? 'Viewers and commenters can’t download, print or copy' : 'Viewers and commenters can download, print and copy' });
      }
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
      if (f.is_drive && parent_id !== undefined && parent_id !== f.parent_id) throw bad('A shared drive can’t be moved into a folder');
      if (f.is_drive && trashed !== undefined && f.role !== 'owner') throw forbidden('Only its owner can delete a shared drive');
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

  // Add a shortcut to a file or folder you can open: { parent_id } (none = My Drive). One per place.
  r.post('/:id/shortcut', (req, res) => {
    const t = loadFile(req.params.id, req.user);
    if (t.trashed) throw bad('That is in the trash');
    const parentId = resolveParent(req.body?.parent_id, req.user);
    if (parentId === t.id || (parentId && t.kind === 'folder' && subtreeIds(t.id).includes(parentId))) throw bad('A folder can\'t hold a shortcut to itself');
    const dup = parentId ? q('SELECT id FROM file_shortcuts WHERE parent_id = ? AND target_id = ?').get(parentId, t.id)
      : q('SELECT id FROM file_shortcuts WHERE parent_id IS NULL AND owner_id = ? AND target_id = ?').get(req.user.id, t.id);
    if (dup) return res.json({ id: dup.id, existing: true });
    if (q('SELECT COUNT(*) AS n FROM file_shortcuts WHERE owner_id = ?').get(req.user.id).n >= MAX_SHORTCUTS) throw bad(`Up to ${MAX_SHORTCUTS} shortcuts`);
    const id = uid();
    q('INSERT INTO file_shortcuts (id, owner_id, parent_id, target_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.id, parentId, t.id, now());
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    else sendTo([req.user.id], { type: 'files-changed', parent_id: null });
    res.status(201).json({ id });
  });

  // Remove a shortcut (whoever made it, or anyone who can edit the folder it's in). What it points to stays.
  r.delete('/shortcuts/:sid', (req, res) => {
    const s = q('SELECT * FROM file_shortcuts WHERE id = ?').get(req.params.sid);
    if (!s) throw notFound();
    if (s.owner_id !== req.user.id && !(s.parent_id && atLeast(roleFor(s.parent_id, req.user.id), 'editor'))) throw notFound();
    q('DELETE FROM file_shortcuts WHERE id = ?').run(s.id);
    if (s.parent_id) notify(s.parent_id, { type: 'files-changed', parent_id: s.parent_id });
    else sendTo([req.user.id], { type: 'files-changed', parent_id: null });
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    // Yours, or (deleted already) anything in a shared drive you can edit.
    const f = loadFile(req.params.id, req.user, 'editor');
    if (f.role !== 'owner' && !(f.trashed && driveOf(f.id))) throw forbidden('You need owner access');
    keepIfHeld(f.owner_id, `“${f.name}”`);
    const audience = audienceFor(f.id);
    tx(() => permanentlyDelete(f.id));
    audit(req, 'file.delete', { target: f.name });
    sendTo(audience, { type: 'files-changed', parent_id: f.parent_id });
    res.json({ ok: true });
  });

  // Pictures in a presentation, document or spreadsheet: anyone who can open it sees them, even if the
  // picture file itself isn't shared with them. Only pictures it uses, owned by someone who can edit it.
  r.get('/:id/pictures/:pic', (req, res) => {
    const deck = loadFile(req.params.id, req.user);
    if (!['slides', 'doc', 'sheet'].includes(deck.kind)) throw notFound();
    const pic = String(req.params.pic);
    const { content } = q('SELECT content FROM files WHERE id = ?').get(deck.id);
    const used = picturesIn(deck.kind, JSON.parse(content || '{}')).has(pic)
      // Just put in and not saved yet: the person who added it can see their own picture.
      || q("SELECT 1 FROM files WHERE id = ? AND owner_id = ?").get(pic, req.user.id);
    const f = used && q('SELECT * FROM files WHERE id = ? AND kind = ? AND trashed = 0').get(pic, 'file');
    const video = deck.kind === 'slides' && /^video\/(mp4|webm|ogg|quicktime)$/.test(f?.mime || ''); // a video on a slide (played from here, seeking included)
    if (!f || !(video || /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mime || '')) || !atLeast(roleFor(deck.id, f.owner_id), 'editor')) throw notFound('Picture not found');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  // Import slides from another presentation into this one: { from, slides: [slide ids] } gives back
  // copies of those slides (new ids) to put in. Their pictures are copied for the person importing,
  // next to this presentation (or in their Drive), so everyone who can open it sees them.
  r.post('/:id/import-slides', (req, res) => {
    const deck = loadFile(req.params.id, req.user, 'editor');
    const src = loadFile(String(req.body?.from || ''), req.user);
    if (deck.kind !== 'slides' || src.kind !== 'slides') throw bad('Slides can only come from another presentation');
    if (!mayTakeAway(src, src.role)) throw forbidden(NO_TAKING);
    const want = Array.isArray(req.body?.slides) ? req.body.slides.map(String).slice(0, 100) : [];
    if (!want.length) throw bad('Choose the slides to import');
    saveNow(src.id); // what's being changed there right now
    const content = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(src.id).content || '{}');
    const chosen = (content.slides || []).filter((sl) => want.includes(sl.id));
    if (!chosen.length) throw notFound('Those slides aren’t in that presentation any more');
    const parentId = deck.parent_id && atLeast(roleFor(deck.parent_id, req.user.id) || '', 'editor') ? deck.parent_id : null;
    const copied = new Map(); // old picture id -> new
    const pics = [...picturesIn('slides', { slides: chosen })].map((pid) => q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(pid)).filter(Boolean);
    checkQuota(req.user.org_id, pics.reduce((n, f) => n + (f.size || 0), 0), req.user.id);
    for (const f of pics) {
      // Only pictures this presentation could show (owned by someone who can edit it), like the deck does.
      if (!/^image\//.test(f.mime || '') || !atLeast(roleFor(src.id, f.owner_id) || '', 'editor')) continue;
      const storage = uid();
      fs.copyFileSync(path.join(FILES_DIR, f.storage), path.join(FILES_DIR, storage));
      copied.set(f.id, insertFile({ owner: req.user.id, parentId, name: f.name, kind: 'file', mime: f.mime, size: f.size, storage, activity: { action: 'copy', details: { from: `${f.name} in ${src.name}` } } }));
    }
    const fresh = () => crypto.randomBytes(6).toString('base64url');
    const slides = chosen.map(({ bgImage, ...sl }) => ({ ...JSON.parse(JSON.stringify(sl)), id: fresh(), ...(bgImage && copied.has(bgImage) && { bgImage: copied.get(bgImage) }),
      items: (sl.items || []).flatMap((it) => (it.type === 'image' && it.fileId && !copied.has(it.fileId) ? [] : [{ ...it, id: fresh(), ...(it.type === 'image' && it.fileId ? { fileId: copied.get(it.fileId) } : {}) }])) }));
    if (parentId && copied.size) notify(parentId, { type: 'files-changed', parent_id: parentId });
    res.json({ slides, theme: content.theme || null });
  });

  // Open a Word, Excel or PowerPoint file as a Docs, Sheets or Slides copy, next to it if you can
  // add files there (otherwise in your Drive). The original stays as it is.
  /** A Word, Excel, PowerPoint, OpenDocument or Markdown file f as a new document, spreadsheet or presentation for user: its id. */
  const convertOffice = async (f, user) => {
    const req = { user }; // (as the route had it)
    const type = f.kind === 'file' && officeType(f.name);
    if (!type) throw bad('Only Word (.docx), OpenDocument (.odt, .ods, .odp), Excel (.xlsx), PowerPoint (.pptx) and Markdown (.md) files can be opened this way');
    if (f.size > MAX_CONVERT) throw bad('This file is too large to convert (50 MB at most)');
    const parentId = f.parent_id && atLeast(roleFor(f.parent_id, req.user.id), 'editor') ? f.parent_id : null;
    const buf = fs.readFileSync(path.join(FILES_DIR, f.storage));
    const name = f.name.replace(/\.[a-z]+$/i, '');
    let content, watermark = '', layout = { columns: 1, lineNumbers: false }, wordComments = [], slideComments = [], sheetThreads = [];
    let folder = null;
    // The document's or presentation's pictures go in a folder of their own beside it.
    const savePicture = async (pname, data, mime) => {
      folder ??= insertFile({ owner: req.user.id, parentId, name: `${name} pictures`, kind: 'folder' });
      checkQuota(req.user.org_id, data.length, req.user.id);
      const storage = uid();
      fs.writeFileSync(path.join(FILES_DIR, storage), data);
      return insertFile({ owner: req.user.id, parentId: folder, name: pname, kind: 'file', mime, size: data.length, storage });
    };
    try {
      if (type === 'docx') { const w = await docFromWord(buf, { savePicture }); content = w.doc; wordComments = w.comments || []; watermark = await watermarkOfWord(buf); layout = { ...(await layoutOfWord(buf)), ...(await pageOfWord(buf)) }; }
      else if (type === 'odt') content = (await docFromOdt(buf, { savePicture })).doc;
      else if (type === 'md' || type === 'markdown') content = docFromMarkdown(buf.toString('utf8'));
      else if (type === 'xlsx') { content = await sheetFromExcel(buf); sheetThreads = commentsOfBook(content); }
      else if (type === 'ods') content = await sheetFromOds(buf);
      else if (type === 'odp') content = await deckFromOdp(buf, { savePicture });
      else { content = await deckFromPowerPoint(buf, { savePicture }); slideComments = commentsOfDeck(content); }
    } catch (e) { throw bad(`This file couldn't be read as ${type === 'odt' ? 'an OpenDocument text file' : type === 'ods' ? 'an OpenDocument spreadsheet' : type === 'odp' ? 'an OpenDocument presentation' : type === 'docx' ? 'a Word document' : type === 'xlsx' ? 'an Excel workbook' : 'a PowerPoint presentation'}`); }
    const json = JSON.stringify(content);
    const id = insertFile({ owner: req.user.id, parentId, name, kind: OFFICE[type].kind, content: json, size: Buffer.byteLength(json) });
    // A Word file's comments: threads on the same words, by whoever opened it, naming who wrote them in Word.
    const signed = (c) => (c.author ? `${c.text}\n\n— ${c.author} (in the Word file)` : c.text);
    for (const c of wordComments) {
      q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, resolved, resolved_by, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)')
        .run(c.id, id, req.user.id, signed(c), JSON.stringify({ quote: c.quote || '' }), c.resolved ? 1 : 0, c.resolved ? req.user.id : null, c.at || now());
      for (const r of c.replies || []) {
        q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
          .run(uid(), id, c.id, req.user.id, signed(r), r.at || c.at || now());
      }
    }
    // An Excel file's comment threads (Microsoft 365's): on their cells, with replies (and resolved when they were).
    const signedXl = (c) => (c.author ? `${c.text}\n\n— ${c.author} (in the Excel file)` : c.text);
    for (const c of sheetThreads) {
      const tid = uid();
      q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, resolved, resolved_by, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)')
        .run(tid, id, req.user.id, signedXl(c), JSON.stringify({ sheet: c.sheet, cell: c.cell }), c.resolved ? 1 : 0, c.resolved ? req.user.id : null, c.at || now());
      for (const r of c.replies) q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(uid(), id, tid, req.user.id, signedXl(r), r.at || c.at || now());
    }
    // A PowerPoint file's comments: threads on their slides, with their replies (and resolved when they were).
    const signedPpt = (c) => (c.author ? `${c.text}\n\n— ${c.author} (in the PowerPoint file)` : c.text);
    for (const c of slideComments) {
      const tid = uid();
      q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, resolved, resolved_by, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)')
        .run(tid, id, req.user.id, signedPpt(c), JSON.stringify({ slide: c.slideId }), c.resolved ? 1 : 0, c.resolved ? req.user.id : null, c.at || now());
      for (const r of c.replies) q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(uid(), id, tid, req.user.id, signedPpt(r), r.at || c.at || now());
    }
    // A Word file's page setup stays: paper, orientation, margins, header, footer, page numbers, watermark, columns, line numbers.
    if (type === 'docx') {
      const setup = readSetup({ watermark, ...layout });
      const plain = JSON.stringify(readSetup({}));
      if (JSON.stringify(setup) !== plain) q('UPDATE files SET page_setup = ? WHERE id = ?').run(JSON.stringify(setup), id);
    }
    if (parentId) notify(parentId, { type: 'files-changed', parent_id: parentId });
    return id;
  };
  r.post('/:id/open-as', async (req, res) => {
    const id = await convertOffice(loadFile(req.params.id, req.user), req.user);
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  /** A document, spreadsheet or presentation as a file of the given type (docx, odt, md, xlsx, ods, pptx, odp), as it stands now. */
  const exportedAs = async (f, type) => {
    saveNow(f.id); // what's being typed right now goes in too
    const stored = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(f.id).content || '{}');
    // Pending suggestions aren't in it yet; a Word download carries them as tracked changes.
    const content = f.kind === 'doc' && type !== 'docx' ? withoutSuggestions(stored) : stored;
    // The same rule as showing pictures in the file: only pictures owned by someone who can edit it.
    const pictureData = async (fileId) => {
      const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
      if (!pic || !(/^image\//.test(pic.mime || '') || (f.kind === 'slides' && /^video\//.test(pic.mime || ''))) || !atLeast(roleFor(f.id, pic.owner_id), 'editor')) return null; // pictures, and videos on slides
      return { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime };
    };
    if (type === 'md') return Buffer.from(markdownFromDoc(content), 'utf8');
    if (type === 'odt') return odtFromDoc(content, f.name, { pictureData });
    if (type === 'ods') return odsFromSheet(content);
    if (type === 'odp') return odpFromDeck(content, { pictureData, title: f.name });
    if (type === 'docx') return wordFromDoc(content, f.name, { pictureData, page: setupOf(f), comments: wordCommentsOf(f.id), signatures: (await import('./signatures.js')).signedRecord(f.id) });
    if (type === 'xlsx') return excelFromSheet(content, { comments: cellCommentsOf(f.id) });
    return powerPointFromDeck(content, { title: f.name, pictureData, comments: slideCommentsOf(f.id) });
  };
  // Which types each kind can be had as (the first is the usual one).
  const EXPORT_TYPES = { doc: ['docx', 'odt', 'md'], sheet: ['xlsx', 'ods'], slides: ['pptx', 'odp'] };
  const exportType = (f, format) => (EXPORT_TYPES[f.kind]?.includes(format) ? format : EXPORT_AS[f.kind]);

  // Download a document, spreadsheet or presentation as Word, Excel or PowerPoint (or OpenDocument, Markdown).
  r.get('/:id/export', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!mayTakeAway(f, f.role)) throw forbidden(NO_TAKING);
    if (!EXPORT_AS[f.kind]) throw bad('Only documents, spreadsheets and presentations can be downloaded this way');
    const type = exportType(f, req.query.format);
    const buf = await exportedAs(f, type);
    res.setHeader('Content-Type', OFFICE[type].mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${f.name}.${type}`)}`);
    res.send(buf);
  });

  // A copy of a document, spreadsheet or presentation as a file (Word, OpenDocument…), to attach to an email:
  // saved in your "Email attachments" folder, as it stands now. The original stays as it is.
  r.post('/:id/export-copy', async (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (!mayTakeAway(f, f.role)) throw forbidden(NO_TAKING);
    if (!EXPORT_AS[f.kind]) throw bad('Only documents, spreadsheets and presentations can be attached this way');
    const type = exportType(f, req.body?.format);
    const buf = await exportedAs(f, type);
    checkQuota(req.user.org_id, buf.length, req.user.id);
    let folderId = q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Email attachments' AND trashed = 0").get(req.user.id)?.id;
    if (!folderId) folderId = insertFile({ owner: req.user.id, parentId: null, name: 'Email attachments', kind: 'folder' });
    const storage = uid();
    fs.writeFileSync(path.join(FILES_DIR, storage), buf);
    const name = cleanName(`${f.name}.${type}`), mime = OFFICE[type].mime.split(';')[0];
    // Attached before: the same file, as it is now (the earlier copy kept as a version), so it keeps its name.
    const before = q("SELECT id FROM files WHERE owner_id = ? AND parent_id = ? AND kind = 'file' AND name = ? AND trashed = 0").get(req.user.id, folderId, name);
    let id = before?.id;
    if (id) {
      tx(() => {
        snapshot(id);
        q('UPDATE files SET storage = ?, size = ?, mime = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(storage, buf.length, mime, now(), req.user.id, id);
      });
    } else id = insertFile({ owner: req.user.id, parentId: folderId, name, kind: 'file', mime, size: buf.length, storage, activity: { action: 'copy', details: { from: f.name } } });
    notify(folderId, { type: 'files-changed', parent_id: folderId });
    res.status(201).json(publicFile(loadFile(id, req.user)));
  });

  // ---- version history ----
  const versionOf = (f, vid) => {
    const v = q('SELECT * FROM file_versions WHERE id = ? AND file_id = ?').get(vid, f.id);
    if (!v) throw notFound('That version is no longer there');
    return v;
  };
  // A spreadsheet cell's edit history (editors): ?sheet=<index>&name=<sheet name>&cell=B4 → [{ value, before, by, by_name, at }].
  r.get('/:id/cell-history', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'editor');
    if (f.kind !== 'sheet') throw bad('Only spreadsheets have cell history');
    const cell = String(req.query.cell || '').toUpperCase();
    if (!/^[A-Z]{1,3}\d{1,7}$/.test(cell)) throw bad('Which cell?');
    saveNow(f.id);
    const cur = q('SELECT content, updated_at, updated_by, owner_id FROM files WHERE id = ?').get(f.id);
    const parse = (c) => { try { return JSON.parse(c || '{}'); } catch { return {}; } };
    const states = [{ content: parse(cur.content), by: cur.updated_by || cur.owner_id, at: cur.updated_at },
      ...q('SELECT content, saved_by, saved_at FROM file_versions WHERE file_id = ? AND content IS NOT NULL ORDER BY saved_at DESC, version DESC').all(f.id).map((v) => ({ content: parse(v.content), by: v.saved_by, at: v.saved_at }))];
    const list = cellHistory(states, { index: Number(req.query.sheet) || 0, name: req.query.name ? String(req.query.name) : null, cell });
    const names = new Map(q('SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...new Set(list.map((x) => x.by).filter(Boolean))])).map((u) => [u.id, u.name]));
    res.json(list.map((x) => ({ ...x, by_name: names.get(x.by) || 'Someone' })));
  });

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
    const owner = q('SELECT id, org_id FROM users WHERE id = ?').get(f.owner_id);
    const { storage, size } = await receiveUpload(req, owner.org_id, maxUploadBytes, owner.id);
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
    if (!mayTakeAway(f, f.role)) throw forbidden(NO_TAKING);
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
    if (v.content) protectionsKept(f, v.content, req.user);
    let storage = null;
    if (v.storage) {
      const owner = q('SELECT org_id FROM users WHERE id = ?').get(f.owner_id);
      checkQuota(owner.org_id, v.size, f.owner_id);
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
    keepIfHeld(f.owner_id, 'Its versions');
    const list = q('SELECT id, size, storage FROM file_versions WHERE file_id = ?').all(f.id);
    q('DELETE FROM file_versions WHERE file_id = ?').run(f.id);
    for (const v of list) if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
    res.json({ deleted: list.length, freed: list.reduce((n, v) => n + v.size, 0) });
  });

  r.delete('/:id/versions/:vid', (req, res) => {
    const f = loadFile(req.params.id, req.user, 'owner');
    keepIfHeld(f.owner_id, 'This version');
    const v = versionOf(f, req.params.vid);
    q('DELETE FROM file_versions WHERE id = ?').run(v.id);
    if (v.storage) fs.rm(path.join(FILES_DIR, v.storage), { force: true }, () => {});
    res.json({ ok: true });
  });

  // How long a document is (for Details): words, characters, paragraphs and minutes to read, as Docs counts them.
  r.get('/:id/length', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    if (f.kind !== 'doc') throw bad('Only documents have a word count');
    saveNow(f.id); // what's being typed right now counts too
    const stored = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(f.id).content || '{}');
    const c = countText(docText(withoutSuggestions(stored))); // pending suggestions aren't in it yet
    res.json({ ...c, minutes: readingMinutes(c.words) });
  });

  // What happened to it, newest first (anyone who can open it sees this).
  r.get('/:id/activity', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(activityOf(f.id));
  });

  r.get('/:id/shares', (req, res) => {
    const f = loadFile(req.params.id, req.user);
    res.json(q(`SELECT s.user_id, s.direct_role, s.expires_at, u.name, u.username, o.name AS org_name, (u.org_id != ?) AS external
                FROM shares s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                WHERE s.file_id = ? AND s.direct_role IS NOT NULL ORDER BY u.name`).all(req.user.org_id, f.id)
      .map(({ direct_role: role, ...s }) => ({ ...s, role, external: !!s.external })));
  });

  // Groups it's shared with: [{ group_id, role, name, members }]; the owner sets them ({ groups: [{ group_id, role }] }).
  r.get('/:id/groups', (req, res) => { const f = loadFile(req.params.id, req.user); res.json(groupsOf(f.id)); });
  r.put('/:id/groups', (req, res) => {
    const f = loadManaged(req.params.id, req.user);
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
    const f = loadManaged(req.params.id, req.user);
    const role = ['viewer', 'commenter', 'editor'].includes(req.body.role) ? req.body.role : null;
    const before = audienceFor(f.id);
    q('UPDATE files SET org_role = ? WHERE id = ?').run(role, f.id);
    sendTo(new Set([...before, ...audienceFor(f.id)]), { type: 'files-changed', parent_id: f.parent_id });
    const orgName = q('SELECT name FROM orgs WHERE id = ?').get(req.user.org_id)?.name || 'the company';
    recordActivity(f.id, req.user.id, 'share', role ? { added: [`everyone at ${orgName} (${role === 'editor' ? 'can edit' : role === 'commenter' ? 'can comment' : 'can view'})`], removed: [] } : { added: [], removed: [`everyone at ${orgName}`] });
    audit(req, 'file.share', { target: f.name, details: { with: [role ? `everyone (${role})` : 'no longer everyone'] } });
    res.json(publicFile(loadFile(f.id, req.user)));
  });

  // Replace the share list: [{ user_id, role }]
  r.put('/:id/shares', async (req, res) => {
    const f = loadManaged(req.params.id, req.user);
    const list = Array.isArray(req.body.shares) ? req.body.shares : null;
    if (!list) throw bad('shares must be an array');
    // Data protection rules, when it newly reaches someone in another company.
    const already = new Set(q('SELECT user_id FROM shares WHERE file_id = ?').all(f.id).map((x) => x.user_id));
    const outsiders = list.filter((s) => !already.has(s.user_id) && q('SELECT org_id FROM users WHERE id = ?').get(String(s.user_id || ''))?.org_id !== req.user.org_id);
    if (outsiders.length && await fileRulesStop(req, res, filesFor(f), 'shared outside the company', audit, f.name)) return;
    const before = audienceFor(f.id);
    const had = new Set(q('SELECT user_id FROM shares WHERE file_id = ? AND direct_role IS NOT NULL').all(f.id).map((x) => x.user_id));
    tx(() => {
      // People shared with one by one; access through groups is worked out again after (syncShares).
      q('UPDATE shares SET direct_role = NULL, expires_at = NULL WHERE file_id = ?').run(f.id);
      for (const s of list) {
        if (!['viewer', 'commenter', 'editor'].includes(s.role)) throw bad('role must be viewer, commenter or editor');
        // Until when (optional): a moment in the future, up to a year ahead.
        const until = s.expires_at === undefined || s.expires_at === null || s.expires_at === '' ? null : Number(s.expires_at);
        if (until !== null && (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + MAX_SHARE_DAYS * 864e5)) throw bad('Access can end at a time in the next year');
        if (s.user_id === f.owner_id) continue;
        if (!canReach(req.user, s.user_id)) throw bad('You cannot share with that person (external sharing may be turned off)');
        q(`INSERT INTO shares (file_id, user_id, role, direct_role, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(file_id, user_id) DO UPDATE SET direct_role = excluded.direct_role, expires_at = excluded.expires_at`).run(f.id, s.user_id, s.role, s.role, until);
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
    const untilText = (x) => (x.expires_at ? ` until ${new Date(Number(x.expires_at)).toISOString().slice(0, 10)}` : '');
    for (const x of added) bell([x.user_id], { kind: 'share', title: `${req.user.name || req.user.username} shared “${f.name}” with you`, body: `${x.role === 'editor' ? 'You can edit' : x.role === 'commenter' ? 'You can comment' : 'You can view'}${untilText(x)}`, link: openLink(f), actor: req.user.name });
    res.json({ ok: true });
  });

  return r;
}
