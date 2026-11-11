// Bookmarks in a Chat conversation: a row of links at the top (the plan document, the team's sheet, a
// website), for everyone in it. Anyone in the conversation can add or take one away.
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS chat_bookmarks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS chat_bookmarks_channel ON chat_bookmarks(channel_id, created_at)').run();
export const MAX_BOOKMARKS = 20;

/** A bookmark as given ({ title, url }), tidied, or an error message. Links are web addresses or pages in Workspace. */
export function cleanBookmark(b) {
  const url = String(b?.url ?? '').trim();
  if (!url) return { error: 'Add a link' };
  if (url.length > 1000) return { error: 'That link is too long' };
  const internal = url.startsWith('/') && !url.startsWith('//');
  if (!internal && !/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(url)) return { error: 'Links start with https:// (or / for a page in Workspace)' };
  let title = String(b?.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!title) title = internal ? url : url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').slice(0, 80);
  return { title, url };
}

export const bookmarksOf = (channelId) => q(`SELECT b.id, b.title, b.url, b.created_at, u.name AS added_by FROM chat_bookmarks b LEFT JOIN users u ON u.id = b.created_by
                                            WHERE b.channel_id = ? ORDER BY b.created_at`).all(channelId);
