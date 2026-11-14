// Booking pages: a link you give people (with or without an account) to book time with you. They
// see the free times in your bookable hours (your events, repeating ones included, and invitations
// you haven't declined count as busy), pick one, and leave a name and email. The booking goes on
// your calendar with them as a guest, and they get the invitation by email.
import { audit } from '../audit.js';
import { notify as bell } from '../notifications.js';
import { Router } from 'express';
import crypto from 'node:crypto';
import { q } from '../db.js';
import { uid, str, bad, notFound, HttpError } from '../util.js';
import { sendTo } from '../hub.js';
import { zoneOrUtc } from '../ics.js';
import { hoursOf, withinHours, hoursText } from '../workhours.js';
import { expand } from '../calmath.js';
import { seesDetails, sharesOf, setShares } from '../calshare.js';
import { notifyOutside, setOutside, touch, baseUrl, outEvent } from './calendar.js';
import { mailEnabled } from '../mail/config.js';
import { newCode } from '../meet.js';
import { smtpFor } from '../mail/imap.js';
import { awayToday } from '../mail/afterhours.js';

q(`CREATE TABLE IF NOT EXISTS booking_pages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,         -- the secret in the link
  title TEXT NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL,          -- minutes
  days TEXT NOT NULL,                 -- JSON weekdays, 0 = Sunday
  from_min INTEGER NOT NULL,          -- bookable hours, minutes after midnight in tz
  to_min INTEGER NOT NULL,
  tz TEXT NOT NULL,
  notice_hours INTEGER NOT NULL,      -- how soon a booking may start
  days_ahead INTEGER NOT NULL,        -- how far ahead it may be
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE TABLE IF NOT EXISTS bookings (page_id TEXT NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE, event_id TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
// A gap kept free around each booking, and at most this many bookings a day (0: no limit); and for
// each booking, who made it and the secret in their link to cancel it.
const cols = (t) => q(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('booking_pages').includes('buffer_min')) q('ALTER TABLE booking_pages ADD COLUMN buffer_min INTEGER NOT NULL DEFAULT 0').run();
if (!cols('booking_pages').includes('max_per_day')) q('ALTER TABLE booking_pages ADD COLUMN max_per_day INTEGER NOT NULL DEFAULT 0').run();
for (const c of ['cancel_token', 'name', 'email']) if (!cols('bookings').includes(c)) q(`ALTER TABLE bookings ADD COLUMN ${c} TEXT`).run();
if (!cols('bookings').includes('cancelled_at')) q('ALTER TABLE bookings ADD COLUMN cancelled_at INTEGER').run();
// Reminders: a page can email its visitors the day before (on unless turned off); when each was sent,
// and the address Workspace had when it was booked (for the link in the reminder).
if (!cols('booking_pages').includes('remind')) q('ALTER TABLE booking_pages ADD COLUMN remind INTEGER NOT NULL DEFAULT 1').run();
// Questions the visitor answers when booking (their phone number, company…): [{ label, required }].
if (!cols('booking_pages').includes('questions')) q("ALTER TABLE booking_pages ADD COLUMN questions TEXT NOT NULL DEFAULT '[]'").run();
if (!cols('bookings').includes('reminded_at')) q('ALTER TABLE bookings ADD COLUMN reminded_at INTEGER').run();
// Co-hosts (round robin): colleagues who also take bookings from the page ([user id]); each booking goes
// to a host who is free then, the one with the fewest bookings from the page.
// Where the booked meeting happens: '' (not said), 'video' (a Meet link made for each booking) or 'place' (where_text).
if (!cols('booking_pages').includes('where_kind')) q("ALTER TABLE booking_pages ADD COLUMN where_kind TEXT NOT NULL DEFAULT ''").run();
if (!cols('booking_pages').includes('where_text')) q('ALTER TABLE booking_pages ADD COLUMN where_text TEXT').run();
if (!cols('booking_pages').includes('hosts')) q("ALTER TABLE booking_pages ADD COLUMN hosts TEXT NOT NULL DEFAULT '[]'").run();
if (!cols('bookings').includes('link_base')) q('ALTER TABLE bookings ADD COLUMN link_base TEXT').run();

const MAX_PAGES = 20;
const MAX_HOSTS = 10;
/** Everyone who takes bookings from a page: its owner, then its co-hosts (active, in the same company). */
export function hostsOf(p) {
  const owner = q('SELECT id, name, org_id FROM users WHERE id = ?').get(p.user_id);
  let extra = [];
  try { extra = JSON.parse(p.hosts || '[]'); } catch { /* none */ }
  const co = extra.filter((id) => id !== p.user_id).map((id) => q('SELECT id, name, org_id FROM users WHERE id = ? AND disabled = 0').get(id)).filter((u) => u && u.org_id === owner?.org_id);
  return [...(owner ? [owner] : []), ...co];
}
/** Free start times of several hosts together: a time is free if any of them is ({ host free → [ms] } too). */
export function mergeSlots(lists) {
  const byDate = new Map();
  for (const list of lists) for (const d of list) { const set = byDate.get(d.date) || new Set(); d.slots.forEach((t) => set.add(t)); byDate.set(d.date, set); }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, set]) => ({ date, slots: [...set].sort((a, b) => a - b) }));
}
const namesText = (names) => (names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);
const EMAIL_RE = /^[^\s@<>"(),;:\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DAY = 864e5;

// ---- time in the page's time zone
const fmt = new Map();
function partsAt(t, tz) {
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  const p = Object.fromEntries(fmt.get(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** The moment a wall-clock time happens in a time zone. */
export function zonedTime(y, m, d, minutes, tz) {
  const want = Date.UTC(y, m, d, 0, minutes);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = partsAt(t, tz);
    const off = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
    t = want - off;
  }
  return t;
}

/**
 * The free start times: in each bookable day, every `duration` minutes from the start of the
 * bookable hours, not before `notice`, not overlapping anything busy (nor within `buffer_min` of it),
 * and none on a day that already has `max_per_day` bookings (`booked`: their start times), nor on the
 * company's holidays (`closed`: their days, YYYY-MM-DD). [{ date, slots: [ms] }].
 */
export function freeSlots(page, busy, now = Date.now(), booked = [], closed = new Set()) {
  const gap = (page.buffer_min || 0) * 6e4;
  const perDay = new Map();
  for (const t of booked) { const p = partsAt(t, page.tz); const k = `${p.y}-${p.m}-${p.d}`; perDay.set(k, (perDay.get(k) || 0) + 1); }
  const days = new Set(page.days);
  const today = partsAt(now, page.tz);
  const earliest = now + page.notice_hours * 36e5;
  const step = page.duration * 6e4;
  const out = [];
  for (let i = 0; i < page.days_ahead; i++) {
    const base = new Date(Date.UTC(today.y, today.m, today.d + i));
    const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
    if (!days.has(base.getUTCDay())) continue;
    if (page.max_per_day && (perDay.get(`${y}-${m}-${d}`) || 0) >= page.max_per_day) continue;
    if (closed.has(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)) continue;
    const slots = [];
    for (let min = page.from_min; min + page.duration <= page.to_min; min += page.duration) {
      const s = zonedTime(y, m, d, min, page.tz), e = s + step;
      if (s < earliest) continue;
      if (busy.some((b) => b.start < e + gap && b.end > s - gap)) continue;
      slots.push(s);
    }
    if (slots.length) out.push({ date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, slots });
  }
  return out;
}

/**
 * The owner's busy times between two moments: their events and invitations not declined (all-day ones
 * don't block, except being out of office). Out-of-office times are marked { ooo: true }.
 */
/** The days someone's company is closed (its company holidays, Time off → Team), as YYYY-MM-DD. */
export function closedDays(userId) {
  try {
    return new Set(q('SELECT h.date FROM company_holidays h JOIN users u ON u.org_id = h.org_id WHERE u.id = ?').all(userId).map((h) => h.date));
  } catch { return new Set(); } // no time off tables yet
}

function busyOf(userId, from, to, details = false, except = null) {
  const rows = q(`SELECT e.* FROM events e WHERE (e.owner_id = ? OR e.id IN (SELECT event_id FROM event_guests WHERE user_id = ? AND status != 'no'))
                  AND (e.all_day = 0 OR (e.kind = 'ooo' AND e.owner_id = ?)) AND e.start < ? AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(userId, userId, userId, to, from, from);
  // Events shown as free don't block anything; a private one shows only as busy, even to people who see details.
  return rows.filter((r) => r.id !== except && r.show_as !== 'free').flatMap((r) => expand(outEvent(r), from, to).map((e) => ({ start: e.start, end: e.end, ...(r.kind === 'ooo' && { ooo: true }),
    ...(details && !r.private && { title: r.title || '(No title)', ...(r.location && { location: r.location }) }), ...(details && r.private && { title: 'Busy', private: true }) }))); // shared with you: what it is
}

function readPage(b, current = {}) {
  const pick = (k) => (b[k] !== undefined ? b[k] : current[k]);
  const title = str(pick('title'), { required: true, name: 'Title', max: 100 });
  const description = str(pick('description') ?? '', { max: 1000 }) || null;
  const duration = Number(pick('duration') ?? 30);
  if (![15, 20, 30, 45, 60, 90, 120].includes(duration)) throw bad('Choose a length of 15 minutes to 2 hours');
  const days = [...new Set([].concat(pick('days') ?? [1, 2, 3, 4, 5]).map(Number))].sort();
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Pick at least one day');
  const fromMin = Number(pick('from_min') ?? 540), toMin = Number(pick('to_min') ?? 1020);
  if (!Number.isInteger(fromMin) || !Number.isInteger(toMin) || fromMin < 0 || toMin > 1440 || toMin - fromMin < duration) throw bad('The hours must fit at least one booking');
  const notice = Number(pick('notice_hours') ?? 4), ahead = Number(pick('days_ahead') ?? 30);
  if (!Number.isInteger(notice) || notice < 0 || notice > 336) throw bad('Notice must be 0 to 336 hours');
  if (!Number.isInteger(ahead) || ahead < 1 || ahead > 90) throw bad('Bookings can be 1 to 90 days ahead');
  const tz = zoneOrUtc(pick('tz') || 'UTC');
  const enabled = pick('enabled') === undefined ? 1 : pick('enabled') ? 1 : 0;
  const buffer = Number(pick('buffer_min') ?? 0), maxPerDay = Number(pick('max_per_day') ?? 0);
  if (![0, 5, 10, 15, 30, 60].includes(buffer)) throw bad('Choose a gap of 0 to 60 minutes');
  if (!Number.isInteger(maxPerDay) || maxPerDay < 0 || maxPerDay > 20) throw bad('At most 20 bookings a day');
  const remind = pick('remind') === undefined ? 1 : pick('remind') ? 1 : 0;
  const hostIds = pick('hosts') ?? [];
  if (!Array.isArray(hostIds) || hostIds.length > MAX_HOSTS) throw bad(`At most ${MAX_HOSTS} co-hosts`);
  const hosts = [...new Set(hostIds.map(String))];
  const qs = pick('questions') ?? [];
  if (!Array.isArray(qs) || qs.length > 5) throw bad('At most 5 questions');
  const questions = qs.map((x) => ({ label: str(x?.label, { required: true, name: 'Question', max: 100 }), required: !!x?.required }));
  const whereKind = pick('where_kind') ?? '';
  if (!['', 'video', 'place'].includes(whereKind)) throw bad('Where: a video meeting, a place, or not said');
  const whereText = whereKind === 'place' ? str(pick('where_text'), { required: true, name: 'The place', max: 200 }) : null;
  return { title, description, duration, days, from_min: fromMin, to_min: toMin, tz, notice_hours: notice, days_ahead: ahead, enabled, buffer_min: buffer, max_per_day: maxPerDay, remind, questions, hosts, where_kind: whereKind, where_text: whereText };
}
const shapePage = (p, req) => ({ ...p, days: JSON.parse(p.days), questions: JSON.parse(p.questions || '[]'), hosts: JSON.parse(p.hosts || '[]'),
  host_names: hostsOf(p).slice(1).map((u) => u.name), enabled: !!p.enabled, remind: !!p.remind, url: `${baseUrl(req)}/b/${p.token}`,
  bookings: q('SELECT COUNT(*) AS n FROM bookings WHERE page_id = ? AND cancelled_at IS NULL').get(p.id).n });

/** Co-hosts asked for: colleagues in your company (not you). */
function checkHosts(user, ids) {
  return ids.filter((id) => id !== user.id).map((id) => {
    const u = q('SELECT id, org_id, disabled FROM users WHERE id = ?').get(id);
    if (!u || u.org_id !== user.org_id || u.disabled) throw bad('Co-hosts must be colleagues in your company');
    return u.id;
  });
}

export default function bookingRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(q('SELECT * FROM booking_pages WHERE user_id = ? ORDER BY created_at').all(req.user.id).map((p) => shapePage(p, req))));
  r.post('/', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM booking_pages WHERE user_id = ?').get(req.user.id).n >= MAX_PAGES) throw bad('Too many booking pages');
    const p = readPage(req.body || {});
    const id = uid();
    q(`INSERT INTO booking_pages (id, user_id, token, title, description, duration, days, from_min, to_min, tz, notice_hours, days_ahead, enabled, created_at, buffer_min, max_per_day, remind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.user.id, crypto.randomBytes(12).toString('base64url'), p.title, p.description, p.duration, JSON.stringify(p.days),
      p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.enabled, Date.now(), p.buffer_min, p.max_per_day, p.remind);
    q('UPDATE booking_pages SET questions = ?, hosts = ?, where_kind = ?, where_text = ? WHERE id = ?').run(JSON.stringify(p.questions), JSON.stringify(checkHosts(req.user, p.hosts)), p.where_kind, p.where_text, id);
    res.status(201).json(shapePage(q('SELECT * FROM booking_pages WHERE id = ?').get(id), req));
  });
  const mine = (req) => {
    const p = q('SELECT * FROM booking_pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!p) throw notFound('Booking page not found');
    return p;
  };
  r.patch('/:id', (req, res) => {
    const cur = mine(req);
    const p = readPage(req.body || {}, { ...cur, days: JSON.parse(cur.days), questions: JSON.parse(cur.questions || '[]'), hosts: JSON.parse(cur.hosts || '[]'), enabled: !!cur.enabled });
    q('UPDATE booking_pages SET questions = ?, hosts = ?, where_kind = ?, where_text = ? WHERE id = ?').run(JSON.stringify(p.questions), JSON.stringify(checkHosts(req.user, p.hosts)), p.where_kind, p.where_text, cur.id);
    q(`UPDATE booking_pages SET title = ?, description = ?, duration = ?, days = ?, from_min = ?, to_min = ?, tz = ?, notice_hours = ?, days_ahead = ?, enabled = ?, buffer_min = ?, max_per_day = ?, remind = ? WHERE id = ?`)
      .run(p.title, p.description, p.duration, JSON.stringify(p.days), p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.enabled, p.buffer_min, p.max_per_day, p.remind, cur.id);
    res.json(shapePage(q('SELECT * FROM booking_pages WHERE id = ?').get(cur.id), req));
  });
  r.delete('/:id', (req, res) => { q('DELETE FROM booking_pages WHERE id = ?').run(mine(req).id); res.json({ ok: true }); });
  return r;
}

// ---- the public page
const recent = new Map(); // ip → booking times, to stop a flood
function limit(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 36e5);
  if (list.length >= 10) throw new HttpError(429, 'Too many bookings from here. Try again later.');
  list.push(now);
  recent.set(ip, list);
}

/**
 * Reminder emails to visitors, about a day before: for bookings on pages that send them, starting
 * in the next 24 hours (but not within the hour), made at least 12 hours before they start (no
 * reminder for one booked this afternoon for tomorrow morning), once each. From the owner's address,
 * with the booking's time in the page's time zone and the link to change or cancel it.
 */
export async function sendBookingReminders(now = Date.now()) {
  if (!mailEnabled()) return 0;
  const due = q(`SELECT b.*, p.title AS page_title, p.tz, e.owner_id AS user_id, e.start, e.end FROM bookings b
                 JOIN booking_pages p ON p.id = b.page_id JOIN events e ON e.id = b.event_id JOIN users u ON u.id = e.owner_id
                 WHERE p.remind = 1 AND u.disabled = 0 AND b.cancelled_at IS NULL AND b.reminded_at IS NULL AND b.email IS NOT NULL
                   AND e.start > ? AND e.start <= ? AND b.created_at <= e.start - 12 * 3600000`).all(now + 36e5, now + DAY);
  let sent = 0;
  for (const b of due) {
    q('UPDATE bookings SET reminded_at = ? WHERE cancel_token = ?').run(now, b.cancel_token); // once, even if sending fails
    const owner = q('SELECT * FROM users WHERE id = ?').get(b.user_id);
    const fmtTime = (t) => new Date(t).toLocaleString('en-GB', { timeZone: b.tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const until = new Date(b.end).toLocaleTimeString('en-GB', { timeZone: b.tz, hour: '2-digit', minute: '2-digit' });
    const link = b.link_base ? `${b.link_base}/b/cancel/${b.cancel_token}` : null;
    const text = [`Hello ${b.name || ''},`.replace(' ,', ','), '', `This is a reminder of your booking with ${owner.name}:`, '', b.page_title, `${fmtTime(b.start)} – ${until} (${b.tz})`,
      ...(link ? ['', `To change the time or cancel: ${link}`] : []), '', `— ${owner.name}`].join('\n');
    try {
      await smtpFor(owner).sendMail({ from: { name: owner.name, address: owner.username }, to: b.email, subject: `Reminder: ${b.page_title} with ${owner.name}, ${fmtTime(b.start)}`, text });
      sent++;
    } catch (e) { console.error('[booking] reminder failed:', e.message); }
  }
  return sent;
}

export function publicBookingRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const find = (token) => {
    const p = q(`SELECT b.*, u.name AS owner_name, u.username AS owner_email, u.disabled FROM booking_pages b JOIN users u ON u.id = b.user_id WHERE b.token = ?`).get(String(token || ''));
    if (!p || p.disabled || !p.enabled) throw new HttpError(404, 'This booking page is not available.');
    return { ...p, days: JSON.parse(p.days) };
  };
  // `except`: a booking being moved, which doesn't stand in its own way.
  const bookedOf = (p, now, except) => q('SELECT e.id, e.start FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.page_id = ? AND b.cancelled_at IS NULL AND e.start >= ?').all(p.id, now - DAY).filter((x) => x.id !== except).map((x) => x.start);
  // One host's free times, or (no host given) any host's.
  const hostSlots = (p, hostId, now, except) => freeSlots(p, busyOf(hostId, now, now + (p.days_ahead + 1) * DAY, false, except), now, bookedOf(p, now, except), closedDays(hostId));
  const slotsOf = (p, now = Date.now(), except = null, hostId = null) => (hostId ? hostSlots(p, hostId, now, except) : mergeSlots(hostsOf(p).map((h) => hostSlots(p, h.id, now, except))));
  /** Who takes a booking at `start`: a host free then, the one with the fewest bookings from the page. */
  const hostFor = (p, start) => {
    const free = hostsOf(p).filter((h) => hostSlots(p, h.id, Date.now(), null).some((d) => d.slots.includes(start)));
    const load = (h) => q('SELECT COUNT(*) AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.page_id = ? AND b.cancelled_at IS NULL AND e.owner_id = ?').get(p.id, h.id).n;
    return free.sort((a, b) => load(a) - load(b))[0] || null;
  };
  const pageOf = (b) => { const p = q('SELECT b.*, u.disabled FROM booking_pages b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(b.page_id); return p && !p.disabled && p.enabled ? { ...p, days: JSON.parse(p.days) } : null; };

  // The visitor's link to cancel their booking: /b/cancel/<secret>. What it is, then cancelling it:
  // it comes off the calendar and the owner is told.
  const booking = (ct) => {
    const b = q(`SELECT b.*, p.title AS page_title, p.tz, COALESCE(h.name, u.name) AS owner_name, COALESCE(h.id, u.id) AS owner_id, e.start, e.end
                 FROM bookings b JOIN booking_pages p ON p.id = b.page_id JOIN users u ON u.id = p.user_id LEFT JOIN events e ON e.id = b.event_id LEFT JOIN users h ON h.id = e.owner_id
                 WHERE b.cancel_token = ?`).get(String(ct || ''));
    if (!b) throw new HttpError(404, 'This booking link is not valid.');
    return b;
  };
  r.get('/cancel/:ct', (req, res) => {
    const b = booking(req.params.ct);
    const cancelled = !!b.cancelled_at || !b.start, past = !!b.start && b.start < Date.now();
    const p = !cancelled && !past ? pageOf(b) : null; // other times to move to, while the page takes bookings
    res.json({ title: b.page_title, owner: { name: b.owner_name }, start: b.start, end: b.end, tz: b.tz, cancelled, past, ...(p && { duration: p.duration, days: slotsOf(p, Date.now(), b.event_id, b.owner_id) }) });
  });
  // Moving it to another free time: the calendar event moves, the visitor gets the updated
  // invitation, and the owner is told.
  r.post('/cancel/:ct/move', (req, res) => {
    const b = booking(req.params.ct);
    if (b.cancelled_at || !b.start) throw bad('This booking was cancelled');
    if (b.start < Date.now()) throw bad('This booking has already started');
    const p = pageOf(b);
    if (!p) throw new HttpError(404, 'This booking page is no longer taking bookings');
    const start = Number(req.body?.start);
    if (!slotsOf(p, Date.now(), b.event_id, b.owner_id).some((d) => d.slots.includes(start))) throw new HttpError(409, 'That time has just been taken. Pick another.'); // with the same host
    limit(req.ip);
    q('UPDATE events SET start = ?, end = ?, sequence = sequence + 1 WHERE id = ?').run(start, start + p.duration * 6e4, b.event_id);
    const owner = q('SELECT * FROM users WHERE id = ?').get(b.owner_id);
    const saved = outEvent(q('SELECT * FROM events WHERE id = ?').get(b.event_id));
    notifyOutside(owner, saved, q('SELECT * FROM event_outside_guests WHERE event_id = ?').all(b.event_id), 'update', { base: baseUrl(req), tz: p.tz });
    touch([owner.id]);
    const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: p.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    bell([owner.id], { kind: 'booking', title: `${b.name || 'Someone'} moved “${b.page_title}”`, body: `From ${when(b.start)} to ${when(start)} (${p.tz})`, link: '/calendar', actor: b.name || null });
    res.json({ ok: true, start, end: start + p.duration * 6e4 });
  });
  r.post('/cancel/:ct', (req, res) => {
    const b = booking(req.params.ct);
    if (b.cancelled_at || !b.start) return res.json({ ok: true, already: true });
    if (b.start < Date.now()) throw bad('This booking has already started');
    q('UPDATE bookings SET cancelled_at = ? WHERE cancel_token = ?').run(Date.now(), b.cancel_token);
    q('DELETE FROM events WHERE id = ?').run(b.event_id);
    touch([b.owner_id]);
    const when = new Date(b.start).toLocaleString('en-GB', { timeZone: b.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    bell([b.owner_id], { kind: 'booking', title: `${b.name || 'Someone'} cancelled “${b.page_title}”`, body: `${when} (${b.tz}) is free again`, link: '/calendar', actor: b.name || null });
    res.json({ ok: true });
  });

  r.get('/:token', (req, res) => {
    const p = find(req.params.token);
    res.json({ title: p.title, description: p.description, duration: p.duration, tz: p.tz, owner: { name: namesText(hostsOf(p).map((h) => h.name)) }, questions: JSON.parse(p.questions || '[]'), where: p.where_kind === 'video' ? { kind: 'video' } : p.where_kind === 'place' ? { kind: 'place', text: p.where_text } : null, days: slotsOf(p) });
  });

  r.post('/:token', (req, res) => {
    const p = find(req.params.token);
    const start = Number(req.body?.start);
    const name = str(req.body?.name, { required: true, name: 'Your name', max: 100 });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Enter your email address');
    const note = str(req.body?.note ?? '', { max: 1000 }) || '';
    // The page's questions, answered in order.
    const given = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answers = JSON.parse(p.questions || '[]').map((x, i) => {
      const a = str(given[i] ?? '', { max: 500 }) || '';
      if (x.required && !a.trim()) throw bad(`Please answer “${x.label}”`);
      return a.trim() ? `${x.label}: ${a.trim()}` : null;
    }).filter(Boolean);
    const host = slotsOf(p).some((d) => d.slots.includes(start)) && hostFor(p, start);
    if (!host) throw new HttpError(409, 'That time has just been taken. Pick another.');
    limit(req.ip);
    const owner = q('SELECT * FROM users WHERE id = ?').get(host.id); // the booking goes on this host's calendar
    const id = uid();
    const title = `${p.title}: ${name}`;
    const ct = crypto.randomBytes(18).toString('base64url');
    const cancelUrl = `${baseUrl(req)}/b/cancel/${ct}`;
    const description = [`Booked by ${name} <${email}> through “${p.title}”.`, answers.length && `\n${answers.join('\n')}`, note && `\n${note}`, `\nTo change or cancel this booking: ${cancelUrl}`].filter(Boolean).join('\n');
    // A video meeting of its own (on the host's Meet), or the page's place.
    let meetCode = null;
    if (p.where_kind === 'video') {
      do meetCode = newCode(); while (q('SELECT 1 FROM meetings WHERE code = ?').get(meetCode));
      q('INSERT INTO meetings (code, org_id, created_by, title, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)').run(meetCode, owner.org_id, owner.id, title, Date.now(), Date.now());
    }
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until, tz, meet_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, '[]', NULL, ?, ?)`).run(id, owner.id, title, description, p.where_kind === 'place' ? p.where_text : null, start, start + p.duration * 6e4, p.tz, meetCode);
    const { added } = setOutside(id, [email]);
    q("UPDATE event_outside_guests SET status = 'yes', answered_at = ? WHERE event_id = ?").run(Date.now(), id);
    q('INSERT INTO bookings (page_id, event_id, created_at, cancel_token, name, email, link_base) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id, id, Date.now(), ct, name, email, baseUrl(req));
    const saved = outEvent(q('SELECT * FROM events WHERE id = ?').get(id));
    notifyOutside(owner, saved, added.map((g) => ({ ...g, status: 'yes' })), 'invite', { base: baseUrl(req), tz: p.tz });
    touch([owner.id]);
    sendTo([owner.id], { type: 'booking-made', title, start, page: p.title, by: name });
    bell([owner.id], { kind: 'booking', title: `${name} booked “${p.title}”`, body: new Date(start).toLocaleString('en-GB', { timeZone: p.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ` (${p.tz})`, link: '/calendar', actor: name });
    res.status(201).json({ ok: true, title: p.title, start, end: start + p.duration * 6e4, tz: p.tz, owner: { name: owner.name }, cancel_url: cancelUrl,
      meet_url: meetCode ? `${baseUrl(req)}/meet/${meetCode}?name=${encodeURIComponent(name)}` : null, /* their name filled in when they join */ place: p.where_kind === 'place' ? p.where_text : null });
  });
  return r;
}

/**
 * Colleagues' busy times (start and end only, never what or where), for seeing calendars side by
 * side: ?users=id,id&from=ms&to=ms. Only people in your own company, at most 10 at a time, 31 days.
 */
export function freeBusyRoutes() {
  const r = Router();
  r.get('/', (req, res) => {
    const ids = [...new Set(String(req.query.users || '').split(',').filter(Boolean))].slice(0, 10);
    const from = Number(req.query.from), to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * DAY) throw bad('Give from and to, at most 31 days apart');
    const out = {};
    for (const id of ids) {
      const u = q('SELECT id, name, org_id FROM users WHERE id = ? AND disabled = 0').get(id);
      if (!u || u.org_id !== req.user.org_id) continue; // not a colleague: nothing shown
      const details = seesDetails(id, req.user.id); // they share their calendar with you
      out[id] = { name: u.name, details, busy: busyOf(id, from, to, details).sort((a, b) => a.start - b.start) };
    }
    res.json(out);
  });

  // Calendar sharing: { with: [people you share yours with], from: [people who share theirs with you] }.
  r.get('/shares', (req, res) => res.json(sharesOf(req.user.id)));
  // Share yours with exactly these colleagues: { users: [ids], editors: [ids of them who can make and change events] }. Newly added ones get a notification.
  r.put('/shares', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.users) ? req.body.users : []).map(String))].filter((x) => x !== req.user.id);
    if (ids.length > 100) throw bad('At most 100 people');
    for (const id of ids) {
      const u = q('SELECT org_id FROM users WHERE id = ? AND disabled = 0').get(id);
      if (!u || u.org_id !== req.user.org_id) throw bad('You can share your calendar with people in your company');
    }
    const editors = (Array.isArray(req.body?.editors) ? req.body.editors : []).map(String).filter((x) => ids.includes(x));
    const editorsBefore = new Set(sharesOf(req.user.id).with.filter((x) => x.can_edit).map((x) => x.id));
    const { added, removed } = setShares(req.user.id, ids, editors);
    const newEditors = editors.filter((x) => !editorsBefore.has(x));
    if (newEditors.length) bell(newEditors, { kind: 'invite', title: `${req.user.name} lets you manage their calendar`, body: 'Pick it under Calendar at the top of the Calendar sidebar to add and change their events.', link: '/calendar', actor: req.user.name });
    for (const id of newEditors) audit(req, 'calendar.editor', { target: q('SELECT username FROM users WHERE id = ?').get(id)?.username });
    if (added.length) bell(added, { kind: 'invite', title: `${req.user.name} shared their calendar with you`, body: 'See what their events are: Calendar → See a colleague’s calendar…', link: '/calendar', actor: req.user.name });
    sendTo([req.user.id, ...ids, ...removed], { type: 'calendar-shares' }); // their views of yours change
    res.json(sharesOf(req.user.id));
  });

  // Times when you and the colleagues given are all free, for a meeting of `duration` minutes:
  // ?users=id,id&duration=60&tz=Europe/London[&from=ms]. Within everyone's working hours (each in
  // their own time zone; Monday to Friday 9:00–17:00 in yours for anyone who hasn't set theirs),
  // every half hour, over the next two weeks; the first 8 that fit.
  r.get('/suggest', (req, res) => {
    const duration = Number(req.query.duration || 60);
    if (!Number.isInteger(duration) || duration < 15 || duration > 480) throw bad('A meeting of 15 minutes to 8 hours');
    const tz = zoneOrUtc(String(req.query.tz || 'UTC'));
    const now = Date.now();
    const from = Math.max(now, Number(req.query.from) || now);
    const people = [req.user.id];
    for (const id of new Set(String(req.query.users || '').split(',').filter(Boolean))) {
      const u = q('SELECT id, org_id FROM users WHERE id = ? AND disabled = 0').get(id);
      if (u && u.org_id === req.user.org_id && u.id !== req.user.id) people.push(u.id);
      if (people.length > 20) throw bad('At most 20 people');
    }
    const to = from + 15 * DAY;
    const busy = people.flatMap((id) => busyOf(id, from, to));
    const hours = people.map((id) => hoursOf(id, tz));
    const closed = closedDays(req.user.id); // the company's holidays: nobody's meeting then
    const start = partsAt(from, tz);
    const out = [];
    for (let i = 0; i < 15 && out.length < 8; i++) {
      const base = new Date(Date.UTC(start.y, start.m, start.d + i));
      if (closed.has(base.toISOString().slice(0, 10))) continue;
      for (let min = 0; min + duration <= 24 * 60 && out.length < 8; min += 30) {
        const s = zonedTime(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), min, tz), e = s + duration * 6e4;
        if (s < from) continue;
        if (!hours.every((h) => withinHours(s, e, h))) continue;
        if (busy.some((b) => b.start < e && b.end > s)) continue;
        out.push({ start: s, end: e });
      }
    }
    // Whose own hours were kept to (others are taken as the usual 9–5).
    const own = people.map((id, i) => (hours[i].own ? { name: q('SELECT name FROM users WHERE id = ?').get(id)?.name, hours: hoursText(hours[i]), tz: hours[i].tz } : null)).filter(Boolean);
    res.json({ people: people.length, slots: out, hours: own });
  });

  // For an event being planned (?users=id,id&start=ms&end=ms): the colleagues invited who are busy then, or for
  // whom it's outside the working hours they've set, with the time it would be for them ("23:00–00:00").
  r.get('/check', (req, res) => {
    const start = Number(req.query.start), end = Number(req.query.end);
    if (!Number.isFinite(start) || !(end > start) || end - start > 14 * DAY) throw bad('A start and an end');
    const out = [];
    for (const id of [...new Set(String(req.query.users || '').split(',').filter(Boolean))].slice(0, 50)) {
      const u = q('SELECT id, name, org_id FROM users WHERE id = ? AND disabled = 0').get(id);
      if (!u || u.org_id !== req.user.org_id || u.id === req.user.id) continue;
      const h = hoursOf(u.id);
      const outside = h.own && !withinHours(start, end, h);
      const busy = busyOf(u.id, start, end).some((b) => b.start < end && b.end > start);
      const away = awayToday(u.id, start); // their vacation reply (Mail) is on that day
      if (!outside && !busy && !away) continue;
      const t = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: h.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
      out.push({ id: u.id, name: u.name, outside, busy, ...(away && { away: { until: away.until } }), ...(h.own && { local: `${t(start)}–${t(end)}`, tz: h.tz }) });
    }
    res.json(out);
  });
  return r;
}
