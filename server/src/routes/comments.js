// Comments on documents, spreadsheets and presentations: threads anchored to text (Docs: a mark in the document
// with the comment's id, so it moves with the text while people co-edit), to a cell (Sheets) or to a slide (Slides),
// replies, resolving, and @mentions that notify by direct message. Anyone who can open the file
// reads them; editors write them. Mounted at /api/comments.
import { notify } from '../notifications.js';
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { roleFor, atLeast, audienceFor } from '../access.js';
import { myFirstList } from './tasks.js';
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
// Assigned comments: a thread given to someone becomes a task on their list (linked back), ticked off when it's resolved.
for (const c of ['assignee_id TEXT', 'task_id TEXT']) if (!q('PRAGMA table_info(file_comments)').all().some((x) => x.name === c.split(' ')[0])) q(`ALTER TABLE file_comments ADD COLUMN ${c}`).run();

const KINDS = ['doc', 'sheet', 'slides', 'file'];
const APP = { doc: 'docs', sheet: 'sheets', slides: 'slides' };
/** Where a comment opens: in its editor, or (an uploaded file) in Drive's preview. */
const linkTo = (file, commentId) => (APP[file.kind] ? `/${APP[file.kind]}/${file.id}?comment=${commentId}` : `/drive?preview=${file.id}&comment=${commentId}`);
const MENTION_RE = /@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

function loadFile(id, user, needed = 'viewer') {
  const f = q('SELECT id, name, kind, trashed FROM files WHERE id = ?').get(String(id || ''));
  const role = f && roleFor(f.id, user.id);
  if (!f || !role || f.trashed || !KINDS.includes(f.kind)) throw notFound('File not found');
  if (!atLeast(role, needed)) throw forbidden('Only people who can comment on this file can do that');
  return { ...f, role };
}
function readAnchor(kind, a) {
  if (!a || typeof a !== 'object') return null;
  if (kind === 'doc') return { quote: str(a.quote ?? '', { max: 500 }) };
  if (kind === 'file') { // the whole file, or a spot on a picture ({ x, y } in % of its width and height)
    const x = Number(a.x), y = Number(a.y);
    if (a.x === undefined && a.y === undefined) return {};
    if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) throw bad('Comment on a spot inside the picture');
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  }
  if (kind === 'slides') { // the slide's own id, so the comment stays with it when slides move
    const slide = String(a.slide || '');
    if (!/^[\w-]{1,64}$/.test(slide)) throw bad('Comment on a slide');
    return { slide, ...(a.gone && { gone: true }) };
  }
  const cell = String(a.cell || '').toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell)) throw bad('Comment on a cell like B2');
  return { sheet: Number.isInteger(a.sheet) && a.sheet >= 0 ? a.sheet : 0, cell, ...(a.gone && { gone: true }) }; // gone: its cell was deleted
}
const shown = (c) => ({ ...c, anchor: c.anchor ? JSON.parse(c.anchor) : null, resolved: !!c.resolved });
const listOf = (fileId) => q(`SELECT c.*, u.name AS author_name, u.username AS author_email, r.name AS resolved_by_name, a.name AS assignee_name
                             FROM file_comments c LEFT JOIN users u ON u.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by LEFT JOIN users a ON a.id = c.assignee_id
                             WHERE c.file_id = ? ORDER BY c.created_at`).all(fileId).map(shown);
const changed = (fileId) => sendTo(audienceFor(fileId), { type: 'comments-changed', id: fileId });

/** A thread given to someone: a task on their first list, linked to the comment, and a notification. */
function assign(user, file, commentId, body, who) {
  const list = myFirstList(who.id);
  const taskId = uid(), t = now();
  const top = (q('SELECT MIN(position) AS p FROM tasks WHERE list_id = ? AND done_at IS NULL').get(list.id).p ?? 1) - 1;
  q(`INSERT INTO tasks (id, list_id, title, notes, position, link_url, link_label, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, list.id, body.replace(/\s+/g, ' ').slice(0, 200), `Assigned by ${user.name} in a comment on “${file.name}”`, top, linkTo(file, commentId), `Comment on ${file.name}`.slice(0, 200), user.id, t, t);
  q('UPDATE file_comments SET assignee_id = ?, task_id = ? WHERE id = ?').run(who.id, taskId, commentId);
  sendTo([who.id], { type: 'tasks-changed', list_id: list.id });
  if (who.id !== user.id) notify([who.id], { kind: 'task', title: `${user.name} assigned you a comment on “${file.name}”`, body, link: linkTo(file, commentId), actor: user.name });
}
function taskDone(taskId, done) {
  const t = q('SELECT id, list_id FROM tasks WHERE id = ?').get(taskId);
  if (!t) return;
  q('UPDATE tasks SET done_at = ?, updated_at = ? WHERE id = ?').run(done ? now() : null, now(), t.id);
  const list = q('SELECT owner_id FROM task_lists WHERE id = ?').get(t.list_id);
  if (list) sendTo([list.owner_id], { type: 'tasks-changed', list_id: t.list_id });
}

/** Mentioned people: notify those who can open the file; say who can't. */
function mention(user, file, body, commentId) {
  const notified = [], noAccess = [];
  for (const [, email] of body.matchAll(MENTION_RE)) {
    const u = q('SELECT id, name, username FROM users WHERE username = ? AND disabled = 0').get(email.toLowerCase());
    if (!u || u.id === user.id || notified.includes(u.username) || noAccess.includes(email.toLowerCase())) continue;
    if (!canReach(user, u.id) || !roleFor(file.id, u.id)) { noAccess.push(u.username); continue; }
    const ok = sendDirect(user, u.id, `Mentioned you in a comment on “${file.name}”:\n${body}\n\nOpen: ${linkTo(file, commentId)}`);
    if (ok) notified.push(u.username);
    notify([u.id], { kind: 'comment', title: `${user.name || user.username} mentioned you in a comment on “${file.name}”`, body, link: linkTo(file, commentId), actor: user.name });
  }
  return { notified, noAccess };
}

export default function commentRoutes() {
  const r = Router();

  r.get('/:fileId', (req, res) => { const f = loadFile(req.params.fileId, req.user); res.json(listOf(f.id)); });

  // A new thread (with an anchor) or a reply (with thread_id).
  r.post('/:fileId', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'commenter');
    const body = str(req.body.body, { required: true, name: 'Comment', max: 4000 });
    let threadId = null, anchor = null;
    if (req.body.thread_id) {
      const root = q('SELECT id FROM file_comments WHERE id = ? AND file_id = ? AND thread_id IS NULL').get(String(req.body.thread_id), f.id);
      if (!root) throw notFound('That comment is no longer there');
      threadId = root.id;
      q('UPDATE file_comments SET resolved = 0, resolved_by = NULL WHERE id = ?').run(root.id); // a reply reopens it
    } else anchor = readAnchor(f.kind, req.body.anchor);
    const id = typeof req.body.id === 'string' && /^[\w-]{8,64}$/.test(req.body.id) && !q('SELECT 1 FROM file_comments WHERE id = ?').get(req.body.id) ? req.body.id : uid();
    // Assign the new thread to someone who can open the file (they get it as a task).
    let assignee = null;
    if (req.body.assign && !threadId) {
      assignee = q('SELECT id, name, username FROM users WHERE id = ? AND disabled = 0').get(String(req.body.assign));
      if (!assignee || !canReach(req.user, assignee.id) || !roleFor(f.id, assignee.id)) throw bad('Assign it to someone who can open this file (share it with them first)');
    }
    q('INSERT INTO file_comments (id, file_id, thread_id, author_id, body, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, f.id, threadId, req.user.id, body, anchor ? JSON.stringify(anchor) : null, now());
    if (assignee) assign(req.user, f, id, body, assignee);
    const mentions = mention(req.user, f, body, threadId || id);
    changed(f.id);
    res.status(201).json({ comment: listOf(f.id).find((c) => c.id === id), ...mentions });
  });

  r.patch('/:fileId/:id', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'commenter');
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
      if (c.task_id) taskDone(c.task_id, !!req.body.resolved); // its task is ticked off (or back on)
    }
    changed(f.id);
    res.json(listOf(f.id).find((x) => x.id === c.id));
  });

  // Delete a comment (the author, or the file's owner); deleting the first one removes the thread.
  r.delete('/:fileId/:id', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'commenter');
    const c = q('SELECT * FROM file_comments WHERE id = ? AND file_id = ?').get(req.params.id, f.id);
    if (!c) throw notFound();
    if (c.author_id !== req.user.id && f.role !== 'owner') throw forbidden('Only the author or the file\'s owner can delete a comment');
    tx(() => { q('DELETE FROM file_comments WHERE id = ? OR thread_id = ?').run(c.id, c.id); });
    changed(f.id);
    res.json({ ok: true });
  });
  return r;
}
