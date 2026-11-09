// Company emoji (Chat): small pictures people add with a name, used as :name: in messages and as
// reactions. Each company has its own; the pictures are kept here (128 KB at most each).
import { q } from './db.js';
import { bad } from './util.js';
import { sniffImage } from './contactphotos.js';

q(`CREATE TABLE IF NOT EXISTS chat_emoji (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data BLOB NOT NULL,
  mime TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, name)
)`).run();

export const MAX_EMOJI = 128 * 1024;
export const MAX_EMOJI_COUNT = 500;
export const EMOJI_NAME = /^[a-z0-9_-]{2,32}$/;
/** ":party-parrot:" → "party-parrot" (a company emoji's name, as a reaction or in text), or null. */
export const customName = (s) => /^:([a-z0-9_-]{2,32}):$/.exec(String(s || ''))?.[1] || null;

/** A cleaned name ("Party Parrot" → "party-parrot"), or an error for one that can't be made fit. */
export function cleanName(raw) {
  const n = String(raw || '').trim().toLowerCase().replace(/^:+|:+$/g, '').replace(/\s+/g, '-');
  if (!EMOJI_NAME.test(n)) throw bad('A name of 2 to 32 letters, numbers, - or _');
  return n;
}

export const listEmoji = (orgId) => q(`SELECT e.name, e.created_by, u.name AS created_by_name, e.created_at FROM chat_emoji e
  LEFT JOIN users u ON u.id = e.created_by WHERE e.org_id = ? ORDER BY e.name`).all(orgId);
export const hasEmoji = (orgId, name) => !!q('SELECT 1 FROM chat_emoji WHERE org_id = ? AND name = ?').get(orgId, name);
export const emojiImage = (orgId, name) => q('SELECT data, mime, created_at FROM chat_emoji WHERE org_id = ? AND name = ?').get(orgId, name) || null;

export function addEmoji(orgId, userId, rawName, buf) {
  const name = cleanName(rawName);
  if (!buf?.length || buf.length > MAX_EMOJI) throw bad('A picture of 128 KB at most');
  const mime = sniffImage(buf);
  if (!mime) throw bad('Choose a PNG, GIF, JPEG or WebP picture');
  if (hasEmoji(orgId, name)) throw bad(`:${name}: is already taken`);
  if (q('SELECT COUNT(*) AS n FROM chat_emoji WHERE org_id = ?').get(orgId).n >= MAX_EMOJI_COUNT) throw bad(`Your company has ${MAX_EMOJI_COUNT} emoji: remove one first`);
  q('INSERT INTO chat_emoji (org_id, name, data, mime, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, name, buf, mime, userId, Date.now());
  return name;
}

/** Who may take one away: whoever added it, or an admin. */
export function removeEmoji(orgId, user, name) {
  const e = q('SELECT created_by FROM chat_emoji WHERE org_id = ? AND name = ?').get(orgId, name);
  if (!e) return false;
  if (e.created_by !== user.id && !user.is_admin) throw bad('Only whoever added it, or an admin, can remove it');
  q('DELETE FROM chat_emoji WHERE org_id = ? AND name = ?').run(orgId, name);
  return true;
}
