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

const MAX_PAGES = 20;
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
 * bookable hours, not before `notice`, not overlapping anything busy. [{ date, slots: [ms] }].
 */
export function freeSlots(page, busy, now = Date.now()) {
  const days = new Set(page.days);
  const today = partsAt(now, page.tz);
  const earliest = now + page.notice_hours * 36e5;
  const step = page.duration * 6e4;
  const out = [];
  for (let i = 0; i < page.days_ahead; i++) {
    const base = new Date(Date.UTC(today.y, today.m, today.d + i));
    const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
    if (!days.has(base.getUTCDay())) continue;
    const slots = [];
    for (let min = page.from_min; min + page.duration <= page.to_min; min += page.duration) {
      const s = zonedTime(y, m, d, min, page.tz), e = s + step;
      if (s < earliest) continue;
      if (busy.some((b) => b.start < e && b.end > s)) continue;
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
function busyOf(userId, from, to, details = false) {
  const rows = q(`SELECT e.* FROM events e WHERE (e.owner_id = ? OR e.id IN (SELECT event_id FROM event_guests WHERE user_id = ? AND status != 'no'))
                  AND (e.all_day = 0 OR (e.kind = 'ooo' AND e.owner_id = ?)) AND e.start < ? AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(userId, userId, userId, to, from, from);
  return rows.flatMap((r) => expand(outEvent(r), from, to).map((e) => ({ start: e.start, end: e.end, ...(r.kind === 'ooo' && { ooo: true }),
    ...(details && { title: r.title || '(No title)', ...(r.location && { location: r.location }) }) }))); // shared with you: what it is
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
  return { title, description, duration, days, from_min: fromMin, to_min: toMin, tz, notice_hours: notice, days_ahead: ahead, enabled };
}
const shapePage = (p, req) => ({ ...p, days: JSON.parse(p.days), enabled: !!p.enabled, url: `${baseUrl(req)}/b/${p.token}`,
  bookings: q('SELECT COUNT(*) AS n FROM bookings WHERE page_id = ?').get(p.id).n });

export default function bookingRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(q('SELECT * FROM booking_pages WHERE user_id = ? ORDER BY created_at').all(req.user.id).map((p) => shapePage(p, req))));
  r.post('/', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM booking_pages WHERE user_id = ?').get(req.user.id).n >= MAX_PAGES) throw bad('Too many booking pages');
    const p = readPage(req.body || {});
    const id = uid();
    q(`INSERT INTO booking_pages (id, user_id, token, title, description, duration, days, from_min, to_min, tz, notice_hours, days_ahead, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.user.id, crypto.randomBytes(12).toString('base64url'), p.title, p.description, p.duration, JSON.stringify(p.days),
      p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.enabled, Date.now());
    res.status(201).json(shapePage(q('SELECT * FROM booking_pages WHERE id = ?').get(id), req));
  });
  const mine = (req) => {
    const p = q('SELECT * FROM booking_pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!p) throw notFound('Booking page not found');
    return p;
  };
  r.patch('/:id', (req, res) => {
    const cur = mine(req);
    const p = readPage(req.body || {}, { ...cur, days: JSON.parse(cur.days), enabled: !!cur.enabled });
    q(`UPDATE booking_pages SET title = ?, description = ?, duration = ?, days = ?, from_min = ?, to_min = ?, tz = ?, notice_hours = ?, days_ahead = ?, enabled = ? WHERE id = ?`)
      .run(p.title, p.description, p.duration, JSON.stringify(p.days), p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.enabled, cur.id);
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

export function publicBookingRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const find = (token) => {
    const p = q(`SELECT b.*, u.name AS owner_name, u.username AS owner_email, u.disabled FROM booking_pages b JOIN users u ON u.id = b.user_id WHERE b.token = ?`).get(String(token || ''));
    if (!p || p.disabled || !p.enabled) throw new HttpError(404, 'This booking page is not available.');
    return { ...p, days: JSON.parse(p.days) };
  };
  const slotsOf = (p, now = Date.now()) => freeSlots(p, busyOf(p.user_id, now, now + (p.days_ahead + 1) * DAY), now);

  r.get('/:token', (req, res) => {
    const p = find(req.params.token);
    res.json({ title: p.title, description: p.description, duration: p.duration, tz: p.tz, owner: { name: p.owner_name }, days: slotsOf(p) });
  });

  r.post('/:token', (req, res) => {
    const p = find(req.params.token);
    const start = Number(req.body?.start);
    const name = str(req.body?.name, { required: true, name: 'Your name', max: 100 });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Enter your email address');
    const note = str(req.body?.note ?? '', { max: 1000 }) || '';
    if (!slotsOf(p).some((d) => d.slots.includes(start))) throw new HttpError(409, 'That time has just been taken. Pick another.');
    limit(req.ip);
    const owner = q('SELECT * FROM users WHERE id = ?').get(p.user_id);
    const id = uid();
    const title = `${p.title}: ${name}`;
    const description = [`Booked by ${name} <${email}> through “${p.title}”.`, note && `\n${note}`].filter(Boolean).join('\n');
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until, tz)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NULL, NULL, '[]', NULL, ?)`).run(id, owner.id, title, description, start, start + p.duration * 6e4, p.tz);
    const { added } = setOutside(id, [email]);
    q("UPDATE event_outside_guests SET status = 'yes', answered_at = ? WHERE event_id = ?").run(Date.now(), id);
    q('INSERT INTO bookings (page_id, event_id, created_at) VALUES (?, ?, ?)').run(p.id, id, Date.now());
    const saved = outEvent(q('SELECT * FROM events WHERE id = ?').get(id));
    notifyOutside(owner, saved, added.map((g) => ({ ...g, status: 'yes' })), 'invite', { base: baseUrl(req), tz: p.tz });
    touch([owner.id]);
    sendTo([owner.id], { type: 'booking-made', title, start, page: p.title, by: name });
    bell([owner.id], { kind: 'booking', title: `${name} booked “${p.title}”`, body: new Date(start).toLocaleString('en-GB', { timeZone: p.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ` (${p.tz})`, link: '/calendar', actor: name });
    res.status(201).json({ ok: true, title: p.title, start, end: start + p.duration * 6e4, tz: p.tz, owner: { name: p.owner_name } });
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
    const start = partsAt(from, tz);
    const out = [];
    for (let i = 0; i < 15 && out.length < 8; i++) {
      const base = new Date(Date.UTC(start.y, start.m, start.d + i));
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
  return r;
}
