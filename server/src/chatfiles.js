// A conversation's files: what was attached to its messages and the Workspace files linked in them,
// newest first, for the Files panel at the top of a conversation.
import { q } from './db.js';
import { roleFor } from './access.js';

export const MAX_CONVERSATION_FILES = 200;
// "/docs/<id>", "/sheets/<id>", "/slides/<id>", "/drive/folder/<id>" or an uploaded file's "/drive?preview=<id>".
const LINK = /(?:^|[\s(<"'])(?:https?:\/\/[^\s/<>"']+)?\/(?:(?:docs|sheets|slides|drive\/folder)\/([\w-]{6,})|drive\/?\?(?:[^\s#]*&)?preview=([\w-]{6,}))/g;

/** Ids of Workspace files linked in a message's text, each once. */
export function linkedFileIds(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LINK)) {
    const id = m[1] || m[2];
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Files in a conversation, for someone in it: [{ id, name, kind, mime, size, how: 'attached'|'linked',
 * message_id, parent_id, user_name, created_at }]. An attachment is listed while its file is still
 * there; a link only when the viewer can open the file. Deleted messages are left out, and each file
 * once (its latest mention). `query` narrows by name.
 */
export function conversationFiles(channelId, userId, query = '') {
  const rows = q(`SELECT m.id, m.parent_id, m.body, m.files, m.created_at, COALESCE(u.name, m.bot, 'Deleted user') AS user_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.deleted_at IS NULL AND (m.files IS NOT NULL OR m.body LIKE '%/%') ORDER BY m.created_at DESC, m.rowid DESC`).all(channelId);
  const seen = new Set();
  const out = [];
  const needle = String(query || '').trim().toLowerCase();
  const file = q("SELECT id, name, kind, mime, size FROM files WHERE id = ? AND trashed = 0");
  const add = (f, how, m) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    if (needle && !f.name.toLowerCase().includes(needle)) return;
    out.push({ id: f.id, name: f.name, kind: f.kind, mime: f.mime || null, size: f.size || 0, how, message_id: m.id, parent_id: m.parent_id || null, user_name: m.user_name, created_at: m.created_at });
  };
  for (const m of rows) {
    if (out.length >= MAX_CONVERSATION_FILES) break;
    for (const a of JSON.parse(m.files || '[]')) {
      const f = a && file.get(String(a.id));
      if (f && f.kind === 'file') add(f, 'attached', m);
    }
    for (const id of linkedFileIds(m.body)) {
      if (seen.has(id)) continue;
      const f = file.get(id);
      if (f && roleFor(f.id, userId)) add(f, 'linked', m);
    }
  }
  return out.slice(0, MAX_CONVERSATION_FILES);
}
