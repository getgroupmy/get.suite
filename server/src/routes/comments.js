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
import { ftsQuery } from '../search.js';

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

// Who each comment @mentions, so "comments for you" is a lookup, not a read of every comment's words.
// Filled in lazily: a comment written (or edited, or imported from Word, Excel, PowerPoint) has mentions_indexed = 0
// until the next lookup reads it.
q(`CREATE TABLE IF NOT EXISTS file_comment_mentions (
  comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  PRIMARY KEY (comment_id, username)
)`).run();
q('CREATE INDEX IF NOT EXISTS file_comment_mentions_user ON file_comment_mentions(username)').run();
if (!q('PRAGMA table_info(file_comments)').all().some((x) => x.name === 'mentions_indexed')) q('ALTER TABLE file_comments ADD COLUMN mentions_indexed INTEGER NOT NULL DEFAULT 0').run();
q('CREATE INDEX IF NOT EXISTS file_comments_unindexed ON file_comments(mentions_indexed) WHERE mentions_indexed = 0').run();
// Their words, for Search everything (full-text, accents ignored), filled in the same lazy way; gone with the comment.
q("CREATE VIRTUAL TABLE IF NOT EXISTS comment_text USING fts5(comment_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')").run();
q('CREATE TRIGGER IF NOT EXISTS comment_text_gone AFTER DELETE ON file_comments BEGIN DELETE FROM comment_text WHERE comment_id = old.id; END').run();

// Emoji reactions on comments (👍 instead of a "Thanks!" reply): one of each emoji per person.
q(`CREATE TABLE IF NOT EXISTS file_comment_reactions (
  comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji)
)`).run();
// When each person last looked at a file's comments: what came after is marked new for them.
q(`CREATE TABLE IF NOT EXISTS file_comment_seen (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
)`).run();
/** For a list of files: fileId → how many open threads have something from someone else since this person last looked. */
export function newCommentCounts(userId, fileIds) {
  if (!fileIds.length) return new Map();
  return new Map(q(`SELECT c.file_id AS id, COUNT(DISTINCT COALESCE(c.thread_id, c.id)) AS n
      FROM file_comments c JOIN file_comments root ON root.id = COALESCE(c.thread_id, c.id)
      LEFT JOIN file_comment_seen s ON s.user_id = ? AND s.file_id = c.file_id
      WHERE c.file_id IN (SELECT value FROM json_each(?)) AND root.resolved = 0 AND COALESCE(c.author_id, '') <> ?
        AND (s.seen_at IS NULL OR COALESCE(c.edited_at, c.created_at) > s.seen_at)
      GROUP BY c.file_id`).all(userId, JSON.stringify(fileIds), userId).map((r) => [r.id, r.n]));
}
export const MAX_REACTION_KINDS = 20; // different emoji on one comment

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
/** Reactions on a file's comments: commentId → [{ emoji, users: [{ id, name }] }], in the order first used. */
function reactionsOf(fileId) {
  const out = new Map();
  for (const r of q(`SELECT x.comment_id, x.emoji, x.user_id, u.name FROM file_comment_reactions x JOIN file_comments c ON c.id = x.comment_id
                     LEFT JOIN users u ON u.id = x.user_id WHERE c.file_id = ? ORDER BY x.created_at`).all(fileId)) {
    if (!out.has(r.comment_id)) out.set(r.comment_id, []);
    const list = out.get(r.comment_id);
    let e = list.find((x) => x.emoji === r.emoji);
    if (!e) list.push(e = { emoji: r.emoji, users: [] });
    e.users.push({ id: r.user_id, name: r.name || 'Someone' });
  }
  return out;
}
const listOf = (fileId) => {
  const reactions = reactionsOf(fileId);
  return q(`SELECT c.*, u.name AS author_name, u.username AS author_email, r.name AS resolved_by_name, a.name AS assignee_name
            FROM file_comments c LEFT JOIN users u ON u.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by LEFT JOIN users a ON a.id = c.assignee_id
            WHERE c.file_id = ? ORDER BY c.created_at`).all(fileId).map((c) => ({ ...shown(c), reactions: reactions.get(c.id) || [] }));
};
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

/**
 * Those following a conversation hear about it in the bell: a reply goes to everyone in its thread (who started
 * it, who replied, who it's assigned to), a new thread to the file's owner. Not to whoever wrote it, nor to
 * people just told because they're @mentioned, nor to anyone who can no longer open the file.
 */
function tellFollowers(user, file, body, threadId, isReply, skipNames) {
  const ids = isReply
    ? q(`SELECT author_id AS id FROM file_comments WHERE id = ? OR thread_id = ? UNION SELECT assignee_id FROM file_comments WHERE id = ?`).all(threadId, threadId, threadId).map((r) => r.id)
    : [q('SELECT owner_id FROM files WHERE id = ?').get(file.id)?.owner_id];
  const who = [...new Set(ids)].filter((id) => id && id !== user.id && roleFor(file.id, id)
    && !skipNames.includes(q('SELECT username FROM users WHERE id = ?').get(id)?.username));
  if (!who.length) return;
  // Someone going through a file leaving many: one notification counting them, with the latest (mentions stay one each).
  const by = user.name || user.username;
  notify(who, { kind: 'reply', title: isReply ? `${by} replied to a comment on “${file.name}”` : `${by} commented on “${file.name}”`,
    body, link: linkTo(file, threadId), actor: user.name,
    group: { key: `comments:${file.id}:${user.id}`, many: (n) => ({ title: `${by} left ${n} comments on “${file.name}”`, body: `The latest: ${body}` }) } });
}

/** Mentioned people: notify those who can open the file; say who can't. `already`: mentioned before (an edit), not told again. */
function mention(user, file, body, commentId, already = new Set()) {
  const notified = [], noAccess = [];
  for (const [, email] of body.matchAll(MENTION_RE)) {
    if (already.has(email.toLowerCase())) continue;
    const u = q('SELECT id, name, username FROM users WHERE username = ? AND disabled = 0').get(email.toLowerCase());
    if (!u || u.id === user.id || notified.includes(u.username) || noAccess.includes(email.toLowerCase())) continue;
    if (!canReach(user, u.id) || !roleFor(file.id, u.id)) { noAccess.push(u.username); continue; }
    const ok = sendDirect(user, u.id, `Mentioned you in a comment on “${file.name}”:\n${body}\n\nOpen: ${linkTo(file, commentId)}`);
    if (ok) notified.push(u.username);
    notify([u.id], { kind: 'comment', title: `${user.name || user.username} mentioned you in a comment on “${file.name}”`, body, link: linkTo(file, commentId), actor: user.name });
  }
  return { notified, noAccess };
}

/** Open comment threads for someone across files they can open: assigned to them, or where someone else @mentioned them. Newest first. */
/** Note who the comments written or changed since the last time @mention, and their words for search. */
export function indexMentions() {
  const rows = q('SELECT id, body FROM file_comments WHERE mentions_indexed = 0 LIMIT 5000').all();
  if (!rows.length) return 0;
  tx(() => {
    for (const r of rows) {
      q('DELETE FROM file_comment_mentions WHERE comment_id = ?').run(r.id);
      q('DELETE FROM comment_text WHERE comment_id = ?').run(r.id);
      q('INSERT INTO comment_text (comment_id, body) VALUES (?, ?)').run(r.id, String(r.body));
      for (const name of new Set([...String(r.body).matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))) q('INSERT OR IGNORE INTO file_comment_mentions (comment_id, username) VALUES (?, ?)').run(r.id, name);
      q('UPDATE file_comments SET mentions_indexed = 1 WHERE id = ?').run(r.id);
    }
  });
  return rows.length;
}

export function commentsFor(me) {
  indexMentions();
  const rows = q(`SELECT c.id, c.thread_id, c.file_id, c.body, c.author_id, c.created_at, c.edited_at, u.name AS author_name, root.assignee_id
                  FROM file_comments c JOIN file_comments root ON root.id = COALESCE(c.thread_id, c.id)
                  JOIN files f ON f.id = c.file_id LEFT JOIN users u ON u.id = c.author_id
                  WHERE root.resolved = 0 AND f.trashed = 0
                    AND c.id IN (SELECT id FROM file_comments WHERE thread_id IS NULL AND assignee_id = ?
                                 UNION SELECT comment_id FROM file_comment_mentions WHERE username = ?)
                    AND (c.id IN (SELECT id FROM file_comments WHERE thread_id IS NULL AND assignee_id = ?) OR COALESCE(c.author_id, '') <> ?)
                  ORDER BY COALESCE(c.edited_at, c.created_at) DESC LIMIT 500`).all(me.id, me.username.toLowerCase(), me.id, me.id);
  const out = new Map();
  for (const c of rows) {
    const thread = c.thread_id || c.id;
    if (out.has(thread)) continue;
    // A real mention of this exact address (not "@ann@acme.com.au"), unless the thread is assigned to you.
    const assigned = c.assignee_id === me.id;
    if (!assigned && ![...c.body.matchAll(MENTION_RE)].some((m) => m[1].toLowerCase() === me.username.toLowerCase())) continue;
    if (!roleFor(c.file_id, me.id)) continue;
    const file = q('SELECT id, name, kind FROM files WHERE id = ?').get(c.file_id);
    out.set(thread, { thread_id: thread, file, body: c.body, author_name: c.author_name, at: c.edited_at || c.created_at, assigned, link: linkTo(file, thread) });
    if (out.size >= 50) break;
  }
  return [...out.values()];
}

export default function commentRoutes() {
  const r = Router();

  // Open comment threads for you, across every file you can open: ones assigned to you, and ones where someone
  // else @mentioned you. Newest first: [{ thread_id, file: { id, name, kind }, body, author_name, at, assigned, link }].
  r.get('/for-me', (req, res) => res.json(commentsFor(req.user)));

  // Search everything: comments (and replies) with these words (or words starting so; accents ignored), on files you can open, newest first, up to 8.
  r.get('/search', (req, res) => {
    const text = String(req.query.q || '').trim();
    const fts = text.length >= 2 ? ftsQuery(text) : null;
    if (!fts) return res.json([]);
    indexMentions();
    const rows = q(`SELECT c.id, c.thread_id, c.file_id, c.body, c.created_at, c.edited_at, u.name AS author_name, root.resolved
                    FROM file_comments c JOIN file_comments root ON root.id = COALESCE(c.thread_id, c.id) JOIN files f ON f.id = c.file_id
                    LEFT JOIN users u ON u.id = c.author_id
                    WHERE f.trashed = 0 AND c.id IN (SELECT comment_id FROM comment_text WHERE comment_text MATCH ? LIMIT 2000)
                    ORDER BY COALESCE(c.edited_at, c.created_at) DESC LIMIT 300`).all(fts);
    const out = [], can = new Map();
    for (const c of rows) {
      if (!can.has(c.file_id)) can.set(c.file_id, !!roleFor(c.file_id, req.user.id));
      if (!can.get(c.file_id)) continue;
      const file = q('SELECT id, name, kind FROM files WHERE id = ?').get(c.file_id);
      const thread = c.thread_id || c.id;
      out.push({ id: c.id, thread_id: thread, file, body: c.body, author_name: c.author_name, at: c.edited_at || c.created_at, resolved: !!c.resolved, link: linkTo(file, thread) });
      if (out.length >= 8) break;
    }
    res.json(out);
  });

  // When you last looked at this file's comments ({ seen_at }, null if never), and marking that you have now.
  r.get('/:fileId/seen', (req, res) => {
    const f = loadFile(req.params.fileId, req.user);
    res.json({ seen_at: q('SELECT seen_at FROM file_comment_seen WHERE user_id = ? AND file_id = ?').get(req.user.id, f.id)?.seen_at ?? null });
  });
  r.post('/:fileId/seen', (req, res) => {
    const f = loadFile(req.params.fileId, req.user);
    const t = now();
    q('INSERT INTO file_comment_seen (user_id, file_id, seen_at) VALUES (?, ?, ?) ON CONFLICT (user_id, file_id) DO UPDATE SET seen_at = excluded.seen_at').run(req.user.id, f.id, t);
    res.json({ seen_at: t });
  });

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
    tellFollowers(req.user, f, body, threadId || id, !!threadId, [...[...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()), ...(assignee ? [assignee.username] : [])]);
    changed(f.id);
    res.status(201).json({ comment: listOf(f.id).find((c) => c.id === id), ...mentions });
  });

  r.patch('/:fileId/:id', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'commenter');
    const c = q('SELECT * FROM file_comments WHERE id = ? AND file_id = ?').get(req.params.id, f.id);
    if (!c) throw notFound();
    let told = null;
    if (req.body.body !== undefined) {
      if (c.author_id !== req.user.id) throw forbidden('Only the author can change a comment');
      const body = str(req.body.body, { required: true, name: 'Comment', max: 4000 });
      if (body !== c.body) {
        q('UPDATE file_comments SET body = ?, edited_at = ?, mentions_indexed = 0 WHERE id = ?').run(body, now(), c.id);
        // People @mentioned for the first time in the edit are told; those mentioned before aren't told again.
        told = mention(req.user, f, body, c.thread_id || c.id, new Set([...c.body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase())));
      }
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
    res.json({ ...listOf(f.id).find((x) => x.id === c.id), ...told });
  });

  // React to a comment with an emoji, or take your reaction back (the same emoji again): anyone who can comment.
  r.post('/:fileId/:id/reactions', (req, res) => {
    const f = loadFile(req.params.fileId, req.user, 'commenter');
    const c = q('SELECT id FROM file_comments WHERE id = ? AND file_id = ?').get(req.params.id, f.id);
    if (!c) throw notFound();
    const emoji = String(req.body?.emoji || '').trim();
    if (!emoji || emoji.length > 16 || /\s/.test(emoji) || /[\p{L}\p{N}]/u.test(emoji)) throw bad('Choose an emoji');
    const had = q('SELECT 1 FROM file_comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').get(c.id, req.user.id, emoji);
    if (had) q('DELETE FROM file_comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').run(c.id, req.user.id, emoji);
    else {
      const kinds = q('SELECT COUNT(DISTINCT emoji) AS n, SUM(emoji = ?) AS mine FROM file_comment_reactions WHERE comment_id = ?').get(emoji, c.id);
      if (!kinds.mine && kinds.n >= MAX_REACTION_KINDS) throw bad('This comment has enough different reactions');
      q('INSERT INTO file_comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(c.id, req.user.id, emoji, now());
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
