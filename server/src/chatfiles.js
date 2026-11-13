// A conversation's files: what was attached to its messages and the Workspace files linked in them,
// newest first, for the Files panel at the top of a conversation.
import { q } from './db.js';
import { roleFor } from './access.js';

export const MAX_CONVERSATION_FILES = 200;

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|md|txt)$/i;
/** What sort of file it is, for the Files panel's filters: pictures, documents, pdf, media or other. */
export function fileType(f) {
  if (['doc', 'sheet', 'slides'].includes(f.kind)) return 'documents';
  if (f.kind === 'folder') return 'other';
  if (/^image\//.test(f.mime || '')) return 'pictures';
  if (/\.pdf$/i.test(f.name) || f.mime === 'application/pdf') return 'pdf';
  if (/^(audio|video)\//.test(f.mime || '')) return 'media';
  if (OFFICE.test(f.name)) return 'documents';
  return 'other';
}
export const FILE_TYPES = ['pictures', 'documents', 'pdf', 'media', 'other'];
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
 * once (its latest mention). `query` narrows by name, `type` by sort of file (see fileType).
 */
export function conversationFiles(channelId, userId, query = '', type = '') {
  if (type && !FILE_TYPES.includes(type)) type = '';
  const rows = q(`SELECT m.id, m.parent_id, m.user_id, m.body, m.files, m.created_at, COALESCE(u.name, m.bot, 'Deleted user') AS user_name
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
    if (type && fileType(f) !== type) return;
    out.push({ id: f.id, name: f.name, kind: f.kind, type: fileType(f), mime: f.mime || null, size: f.size || 0, how, message_id: m.id, parent_id: m.parent_id || null, user_id: m.user_id || null, user_name: m.user_name, created_at: m.created_at });
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

/** Whether someone can read a conversation (a member of a private one or a DM; in the company for a public channel). */
function canRead(c, user) {
  if (c.dm_key || c.private) return !!q('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(c.id, user.id);
  return c.org_id === user.org_id;
}

/**
 * Where a file was shared in Chat, for File details: the conversations you can read in which it was
 * attached or linked, the one with the latest mention first: [{ channel_id, name, dm, private, archived,
 * message_id, parent_id, created_at, user_name, times }]. Deleted messages don't count.
 */
export function fileMentions(fileId, user, limit = 20) {
  const id = String(fileId);
  if (!/^[\w-]{6,}$/.test(id)) return [];
  const rows = q(`SELECT m.id, m.channel_id, m.parent_id, m.created_at, m.files, m.body, COALESCE(u.name, m.bot, 'Deleted user') AS user_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.deleted_at IS NULL AND (instr(m.files, ?) > 0 OR instr(m.body, ?) > 0) ORDER BY m.created_at DESC, m.rowid DESC LIMIT 2000`).all(`"${id}"`, id);
  const by = new Map();
  const channel = q('SELECT id, name, dm_key, private, archived_at, org_id FROM channels WHERE id = ?');
  for (const m of rows) {
    const there = JSON.parse(m.files || '[]').some((f) => f && f.id === id) || linkedFileIds(m.body).includes(id);
    if (!there) continue;
    const seen = by.get(m.channel_id);
    if (seen) { if (seen.times !== undefined) seen.times++; continue; }
    const c = channel.get(m.channel_id);
    if (!c || !canRead(c, user)) { by.set(m.channel_id, {}); continue; }
    let name = c.name;
    if (c.dm_key) {
      const other = c.dm_key.split(':').find((x) => x !== user.id);
      name = other ? (q('SELECT name FROM users WHERE id = ?').get(other)?.name || 'Deleted user') : 'Notes to yourself';
    }
    by.set(m.channel_id, { channel_id: c.id, name, dm: !!c.dm_key, private: !!c.private, archived: !!c.archived_at, message_id: m.id, parent_id: m.parent_id || null, created_at: m.created_at, user_name: m.user_name, times: 1 });
  }
  return [...by.values()].filter((x) => x.channel_id).slice(0, limit);
}
