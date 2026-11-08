// Calendar feeds: someone subscribes to an internet calendar by its address (public holidays, a
// supplier's schedule, a team calendar published as .ics; webcal:// works too). Its events show in
// their calendar, read-only, in the feed's colour, and are fetched again every few hours. Addresses
// on this server's own network aren't fetched (unless CALENDAR_FEEDS_ALLOW_PRIVATE=1, for tests).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { q } from './db.js';
import { uid, bad } from './util.js';
import { splitCalendar } from './calimport.js';
import { parseIcsEvent, zoneOrUtc } from './ics.js';
import { isPrivateAddress, publicLookup } from './mail/unsubscribe.js';
import { sendTo } from './hub.js';

q(`CREATE TABLE IF NOT EXISTS calendar_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
)`).run();

export const MAX_FEEDS = 20, MAX_FEED_BYTES = 5 * 1024 * 1024, MAX_FEED_EVENTS = 5000, REFRESH_MS = 6 * 3600e3;
const allowPrivate = () => process.env.CALENDAR_FEEDS_ALLOW_PRIVATE === '1';

/** The address to fetch: webcal:// becomes https://; only http(s). */
export function feedUrl(raw) {
  let s = String(raw || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:/i, 'https:');
  let u;
  try { u = new URL(s); } catch { throw bad('Give the calendar’s web address, like https://example.com/holidays.ics'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Calendar addresses start with https://, http:// or webcal://');
  if (u.username || u.password) throw bad('Leave the name and password out of the address');
  return u.toString();
}

/** Fetch a feed's text (following up to 3 redirects, each checked), at most MAX_FEED_BYTES. */
export function fetchFeed(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && net.isIP(host) && isPrivateAddress(host)) return reject(new Error('That address is on a private network'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { lookup: allowPrivate() ? undefined : publicLookup, timeout: 15000, headers: { 'User-Agent': 'Workspace-Calendar', Accept: 'text/calendar, */*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('Too many redirects'));
        let next;
        try { next = feedUrl(new URL(res.headers.location, u).toString()); } catch (e) { return reject(e); }
        return fetchFeed(next, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The calendar’s server answered ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_FEED_BYTES) { req.destroy(new Error('The calendar is larger than 5 MB')); return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The calendar’s server didn’t answer in time')));
    req.on('error', (e) => reject(e.code === 'EPRIVATE' ? new Error('That address is on a private network') : e));
  });
}

/** The events in a calendar file, as kept for a feed (repeats and all). */
export function parseFeed(text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address doesn’t give a calendar (.ics)');
  const name = (/\nX-WR-CALNAME:(.*)/i.exec(String(text).replace(/\r\n?/g, '\n'))?.[1] || '').trim().slice(0, 100) || null;
  const events = [];
  for (const part of splitCalendar(text).slice(0, MAX_FEED_EVENTS)) {
    const e = parseIcsEvent(part, { tz: 'UTC' });
    if (e.error) continue;
    events.push({ uid: e.uid || uid(), title: e.title || '(no title)', start: e.start, end: e.end, all_day: e.all_day ? 1 : 0, location: e.location || '', description: (e.description || '').slice(0, 5000),
      rrule: e.rrule || null, exdates: e.exdates || [], tz: zoneOrUtc(e.tz) });
  }
  return { name, events };
}

/** Fetch one feed now and keep its events (or the error, keeping the last good events). */
export async function refreshFeed(feed) {
  try {
    const { events } = parseFeed(await fetchFeed(feed.url));
    q('UPDATE calendar_feeds SET events = ?, fetched_at = ?, error = NULL WHERE id = ?').run(JSON.stringify(events), Date.now(), feed.id);
  } catch (e) {
    q('UPDATE calendar_feeds SET fetched_at = ?, error = ? WHERE id = ?').run(Date.now(), String(e.message).slice(0, 300), feed.id);
  }
  sendTo([feed.user_id], { type: 'events-changed' });
}

/** Add a feed for someone (fetched first, so a wrong address is said at once). */
export async function addFeed(userId, { url, name, color }) {
  if (q('SELECT COUNT(*) AS n FROM calendar_feeds WHERE user_id = ?').get(userId).n >= MAX_FEEDS) throw bad(`Up to ${MAX_FEEDS} calendars`);
  const u = feedUrl(url);
  let parsed;
  try { parsed = parseFeed(await fetchFeed(u)); } catch (e) { throw bad(`That calendar can’t be added: ${e.message}`); }
  const id = uid();
  const title = String(name || '').trim().slice(0, 100) || parsed.name || new URL(u).hostname;
  q('INSERT INTO calendar_feeds (id, user_id, url, name, color, events, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, u, title, /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#7986cb', JSON.stringify(parsed.events), Date.now(), Date.now());
  return feedOf(id);
}

export const feedOf = (id) => {
  const f = q('SELECT id, user_id, url, name, color, fetched_at, error, events FROM calendar_feeds WHERE id = ?').get(id);
  if (!f) return null;
  const { events, user_id, ...rest } = f;
  return { ...rest, events: JSON.parse(events).length };
};
export const feedsOf = (userId) => q('SELECT id FROM calendar_feeds WHERE user_id = ? ORDER BY created_at').all(userId).map((f) => feedOf(f.id));

/** The feeds' events that might fall between from and to (repeating ones whole; the browser expands them). */
export function feedEvents(userId, from, to) {
  const out = [];
  for (const f of q('SELECT id, name, color, events FROM calendar_feeds WHERE user_id = ?').all(userId)) {
    for (const e of JSON.parse(f.events)) {
      if (e.start >= to) continue;
      if (!e.rrule && e.end < from) continue;
      if (e.rrule?.until !== undefined && e.rrule.until + (e.end - e.start) < from) continue;
      out.push({ ...e, id: `feed-${f.id}-${e.uid}`, color: f.color, role: 'feed', feed: { id: f.id, name: f.name }, guests: [], rooms: [], reminders: [], attachments: [] });
    }
  }
  return out;
}

let refreshing = false;
/** Fetch again the feeds that are due (every few hours). */
export async function refreshDueFeeds(now = Date.now()) {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const due = q('SELECT * FROM calendar_feeds WHERE fetched_at IS NULL OR fetched_at < ? ORDER BY fetched_at LIMIT 20').all(now - REFRESH_MS);
    for (const f of due) await refreshFeed(f);
    return due.length;
  } finally { refreshing = false; }
}
