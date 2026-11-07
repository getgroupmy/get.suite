// Comments on documents and spreadsheets: threads anchored to text (Docs: a mark in the document
// with the comment's id, so it moves with the text while people co-edit) or to a cell (Sheets),
// replies, resolving, and @mentions that notify by direct message. Anyone who can open the file
// reads them; editors write them. Mounted at /api/comments.
import { notify } from '../notifications.js';
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { roleFor, atLeast, audienceFor } from '../access.js';
import { canReach } from '../tenancy.js';
import { sendTo } from '../hub.js';
import { sendDirect } from './chat.js';

q(`CREATE TABLE IF NOT EXISTS file_comments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  thread_id TEXT,                     -- null for the first comment of a thread; else that comment's id
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor TEXT,                        -- JSON: { quote } (Docs) or { sheet, cell } (Sheets)
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
)`).run();
q('CREATE INDEX IF NOT EXISTS file_comments_file ON file_comments(file_id, created_at)').run();

const KINDS = ['doc', 'sheet'];
const MENTION_RE = /@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

function loadFile(id, user, needed = 'viewer') {
  const f = q('SELECT id, name, kind, trashed FROM files WHERE id = ?').get(String(id || ''));
  const role = f && roleFor(f.id, user.id);
  if (!f || !role || f.trashed || !KINDS.includes(f.kind)) throw notFound('File not found');
  if (!atLeast(role, needed)) throw forbidden('Only people who can edit this file can comment');
  return { ...f, role };
}
function readAnchor(kind, a) {
  if (!a || typeof a !== 'object') return null;
  if (kind === 'doc') return { quote: str(a.quote ?? '', { max: 500 }) };
  const cell = String(a.cell || '').toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell)) throw bad('Comment on a cell like B2');
  return { sheet: Number.isInteger(a.sheet) && a.sheet >= 0 ? a.sheet : 0, cell, ...(a.gone && { gone: true }) }; // gone: its cell was deleted
}
const shown = (c) => ({ ...c, anchor: c.anchor ? JSON.parse(c.anchor) : null, resolved: !!c.resolved });
const listOf = (fileId) => q(`SELECT c.*, u.name AS author_name, u.username AS author_email, r.name AS resolved_by_name
                             FROM file_comments c LEFT JOIN users u ON u.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by
                             WHERE c.file_id = ? ORDER BY c.created_at`).all(fileId).map(shown);
const changed = (fileId) => sendTo(audienceFor(fileId), { type: 'comments-changed', id: fileId });

/** Mentioned people: notify those who can open the file; say who can't. */
function mention(user, file, body, commentId) {
  const notified = [], noAccess = [];
  for (const [, email] of body.matchAll(MENTION_RE)) {
    const u = q('SELECT id, name, username FROM users WHERE username = ? AND disabled = 0').get(email.toLowerCase());
    if (!u || u.id === user.id || notified.includes(u.username) || noAccess.includes(email.toLowerCase())) continue;
    if (!canReach(user, u.id) || !roleFor(file.id, u.id)) { noAccess.push(u.username); continue; }
    const where = file.kind === 'doc' ? 'docs' : 'sheets';
    const ok = sendDirect(user, u.id, `Mentioned you in a comment on “${file.name}”:\n${body}\n\nOpen: /${where}/${file.id}?comment=${commentId}`);
    if (ok) notified.push(u.username);
    notify([u.id], { kind: 'comment', title: `${user.name || user.username} mentioned you in a comment on “${file.name}”`, body, link: `/${where}/${file.id}?comment=${commentId}`, actor: user.name });
  }
  return { notified, noAccess };
}

export default function commentRoutes() {
  const r = Router();

  r.get('/:fileId', (req, res) => { const f = loadFile(req.params.fileId, req.user); res.json(listOf(f.id)); });

  // A new thread (with an anchor) or a reply (with thread_id).
  r.post('/:fileId', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'editor');
    const body = str(req.body.body, { required: true, name: 'Comment', max: 4000 });
    let threadId = null, anchor = null;
    if (req.body.thread_id) {
      const root = q('SELECT id FROM file_comments WHERE id = ? AND file_id = ? AND thread_id IS NULL').get(String(req.body.thread_id), f.id);
      if (!root) throw notFound('That comment is no longer there');
      threadId = root.id;
      q('UPDATE file_comments SET resolved = 0, resolved_by = NULL WHERE id = ?').run(root.id); // a reply reopens it
    } else anchor = readAnchor(f.kind, req.body.anchor);
    const id = typeof req.body.id === 'string' && /^[\w-]{8,64}$/.test(req.body.id) && !q('SELECT 1 FROM file_comments WHERE id = ?').get(req.body.id) ? req.body.id : uid();
    q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, f.id, threadId, req.user.id, body, anchor ? JSON.stringify(anchor) : null, now());
    const mentions = mention(req.user, f, body, threadId || id);
    changed(f.id);
    res.status(201).json({ comment: listOf(f.id).find((c) => c.id === id), ...mentions });
  });

  r.patch('/:fileId/:id', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'editor');
    const c = q('SELECT * FROM file_comments WHERE id = ? AND file_id = ?').get(req.params.id, f.id);
    if (!c) throw notFound();
    if (req.body.body !== undefined) {
      if (c.author_id !== req.user.id) throw forbidden('Only the author can change a comment');
      q('UPDATE file_comments SET body = ?, edited_at = ? WHERE id = ?').run(str(req.body.body, { required: true, name: 'Comment', max: 4000 }), now(), c.id);
    }
    if (req.body.anchor !== undefined) { // the commented cell moved (rows or columns inserted or deleted)
      if (c.thread_id) throw bad('Move the thread, not a reply');
      q('UPDATE file_comments SET anchor = ? WHERE id = ?').run(JSON.stringify(readAnchor(f.kind, req.body.anchor)), c.id);
    }
    if (req.body.resolved !== undefined) {
      if (c.thread_id) throw bad('Resolve the thread, not a reply');
      q('UPDATE file_comments SET resolved = ?, resolved_by = ? WHERE id = ?').run(req.body.resolved ? 1 : 0, req.body.resolved ? req.user.id : null, c.id);
    }
    changed(f.id);
    res.json(listOf(f.id).find((x) => x.id === c.id));
  });

  // Delete a comment (the author, or the file's owner); deleting the first one removes the thread.
  r.delete('/:fileId/:id', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'editor');
    const c = q('SELECT * FROM file_comments WHERE id = ? AND file_id = ?').get(req.params.id, f.id);
    if (!c) throw notFound();
    if (c.author_id !== req.user.id && f.role !== 'owner') throw forbidden('Only the author or the file\'s owner can delete a comment');
    tx(() => { q('DELETE FROM file_comments WHERE id = ? OR thread_id = ?').run(c.id, c.id); });
    changed(f.id);
    res.json({ ok: true });
  });
  return r;
}
