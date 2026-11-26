import { q } from './db.js';
import { now, bad } from './util.js';

const MAX_REACTION_KINDS = 20; // different emoji on one comment (as on files')

// Emoji reactions on note and task comments (👍 instead of a "Thanks!"), as on files' comments: one of each emoji per person.
const TABLES = { note: ['note_comment_reactions', 'note_comments'], task: ['task_comment_reactions', 'task_comments'] };
export function ensureReactionTables() {
  for (const [table, of] of Object.values(TABLES)) {
    q(`CREATE TABLE IF NOT EXISTS ${table} (
      comment_id TEXT NOT NULL REFERENCES ${of}(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (comment_id, user_id, emoji)
    )`).run();
  }
}
ensureReactionTables(); // (whichever loads first: Notes, Tasks or a download)

/** Reactions on these comments: commentId → [{ emoji, users: [{ id, name }] }], in the order first used. */
export function reactionsOn(kind, commentIds) {
  const [table] = TABLES[kind];
  const out = new Map();
  if (!commentIds.length) return out;
  for (const r of q(`SELECT x.comment_id, x.emoji, x.user_id, u.name FROM ${table} x LEFT JOIN users u ON u.id = x.user_id
                     WHERE x.comment_id IN (SELECT value FROM json_each(?)) ORDER BY x.created_at, x.rowid`).all(JSON.stringify(commentIds))) {
    if (!out.has(r.comment_id)) out.set(r.comment_id, []);
    const list = out.get(r.comment_id);
    let e = list.find((x) => x.emoji === r.emoji);
    if (!e) list.push(e = { emoji: r.emoji, users: [] });
    e.users.push({ id: r.user_id, name: r.name || 'Someone' });
  }
  return out;
}

/** Reactions as words for a download: "👍 Ann Lee, Bob Ray; 🎉 Cy Dee" ("" for none). */
export const reactionsText = (list) => (list || []).map((r) => `${r.emoji} ${r.users.map((u) => u.name).join(', ')}`).join('; ');

/** Adds your reaction, or takes it back (the same emoji again; not with { add: true }, which only adds). */
export function toggleReaction(kind, commentId, userId, raw, { add = false } = {}) {
  const [table] = TABLES[kind];
  const emoji = String(raw || '').trim();
  if (!emoji || emoji.length > 16 || /\s/.test(emoji) || /[\p{L}\p{N}]/u.test(emoji)) throw bad('Choose an emoji');
  if (q(`SELECT 1 FROM ${table} WHERE comment_id = ? AND user_id = ? AND emoji = ?`).get(commentId, userId, emoji)) {
    if (add) return;
    q(`DELETE FROM ${table} WHERE comment_id = ? AND user_id = ? AND emoji = ?`).run(commentId, userId, emoji);
    return;
  }
  const kinds = q(`SELECT COUNT(DISTINCT emoji) AS n, SUM(emoji = ?) AS mine FROM ${table} WHERE comment_id = ?`).get(emoji, commentId);
  if (!kinds.mine && kinds.n >= MAX_REACTION_KINDS) throw bad('This comment has enough different reactions');
  q(`INSERT INTO ${table} (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`).run(commentId, userId, emoji, now());
}
