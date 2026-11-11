// Meeting rooms (and other things to book, like a projector): a company's admins list them; people
// add one to an event, and it's booked when it's free then (every time, for a repeating event, over
// the next six months) or declined when something else has it.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError } from '../util.js';
import { expand } from '../calmath.js';
import { outEvent, touch } from './calendar.js';

q(`CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capacity INTEGER,
  created_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS event_rooms (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- yes (booked) | no (taken by something else)
  PRIMARY KEY (event_id, room_id)
)`).run();
// Where a room is (building, floor) and what's in it (video, a whiteboard…), to pick the right one.
for (const [col, type] of [['location', 'TEXT'], ['features', "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!q('PRAGMA table_info(rooms)').all().some((c) => c.name === col)) q(`ALTER TABLE rooms ADD COLUMN ${col} ${type}`).run();
}
export const MAX_FEATURES = 10;
/** A clean list of what's in a room: trimmed, at most 40 characters each, each once (ignoring case). */
export function cleanFeatures(list) {
  if (!Array.isArray(list)) throw bad('Equipment must be a list');
  const out = [];
  for (const x of list) {
    const v = String(x ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MAX_FEATURES) throw bad(`At most ${MAX_FEATURES} things in a room`);
  return out;
}
const ROOM = 'SELECT id, name, capacity, location, features FROM rooms';
const outRoom = (r) => r && { ...r, features: JSON.parse(r.features || '[]') };
/** ?needs=Video,Whiteboard: rooms that have all of these (ignoring case). */
const needsOf = (req) => String(req.query.needs || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, MAX_FEATURES);
const hasAll = (room, needs) => needs.every((n) => room.features.some((f) => f.toLowerCase() === n));

const WINDOW = 183 * 864e5;
/** The times an event takes up (repeating ones over the next six months). */
const timesOf = (ev, from = ev.start) => (ev.rrule ? expand(ev, from, from + WINDOW) : [{ start: ev.start, end: ev.end }]);

/** Is the room booked by another event at any of these times? Returns that event's title, or null. */
function clash(roomId, eventId, times) {
  if (!times.length) return null;
  const from = Math.min(...times.map((t) => t.start)), to = Math.max(...times.map((t) => t.end));
  const others = q(`SELECT e.* FROM events e JOIN event_rooms r ON r.event_id = e.id
                    WHERE r.room_id = ? AND r.status = 'yes' AND e.id != ? AND e.start < ?
                      AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(roomId, eventId, to, from, from);
  for (const o of others) {
    const busy = timesOf(outEvent(o), from - 864e5).filter((b) => b.start < to && b.end > from);
    if (busy.some((b) => times.some((t) => b.start < t.end && b.end > t.start))) return o.title;
  }
  return null;
}

/** An event's rooms: [{ id, name, status }]. */
export const roomsOf = (eventId) => q(`SELECT r.id, r.name, er.status FROM event_rooms er JOIN rooms r ON r.id = er.room_id WHERE er.event_id = ? ORDER BY r.name`).all(eventId);

/**
 * Set an event's rooms (ids from the organizer's company). Each is booked if free at all the event's
 * times, else declined. Rooms kept from before are checked again (the time may have changed).
 */
export function setRooms(user, eventRow, ids) {
  if (!Array.isArray(ids)) throw bad('Rooms must be a list');
  const want = [...new Set(ids.map(String))].slice(0, 10);
  const rooms = want.map((id) => q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(id, user.org_id));
  if (rooms.some((r) => !r)) throw bad('A room isn’t there any more');
  const ev = outEvent(eventRow);
  const times = timesOf(ev, Math.max(ev.start, Date.now() - 864e5));
  tx(() => {
    q('DELETE FROM event_rooms WHERE event_id = ?').run(ev.id);
    for (const r of rooms) q('INSERT INTO event_rooms (event_id, room_id, status) VALUES (?, ?, ?)').run(ev.id, r.id, clash(r.id, ev.id, times) ? 'no' : 'yes');
  });
  return roomsOf(ev.id);
}

/** A room's bookings that overlap from–to (repeats expanded): [{ start, end, title, organizer }], soonest first. */
function bookingsOf(roomId, from, to) {
  const rows = q(`SELECT e.*, u.name AS organizer FROM events e JOIN event_rooms r ON r.event_id = e.id JOIN users u ON u.id = e.owner_id
                  WHERE r.room_id = ? AND r.status = 'yes' AND e.start < ?
                    AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(roomId, to, from, from);
  return rows.flatMap((row) => expand(outEvent(row), from, to).map((o) => ({ start: o.start, end: o.end, title: row.title, organizer: row.organizer, event_id: row.id, owner_id: row.owner_id, repeating: !!row.rrule })))
    .sort((x, y) => x.start - y.start);
}

const LOOK_AHEAD = 12 * 36e5;
/**
 * Is the room free right now? { busy: { title, organizer, until } | null, next: { start, title } | null }:
 * what's on in it now (until when, counting back-to-back bookings), and the next booking in 12 hours.
 */
export function roomNow(roomId, t = Date.now()) {
  const list = bookingsOf(roomId, t, t + LOOK_AHEAD);
  const on = list.find((b) => b.start <= t && b.end > t);
  if (!on) { const n = list.find((b) => b.start > t); return { busy: null, next: n ? { start: n.start, title: n.title } : null }; }
  let until = on.end;
  for (const b of list) if (b.start <= until && b.end > until) until = b.end;
  const n = list.find((b) => b.start >= until);
  return { busy: { title: on.title, organizer: on.organizer, until }, next: n ? { start: n.start, title: n.title } : null, current: on };
}
/**
 * How much a room was used from–to: bookings, hours booked (overlaps counted once), the share of
 * working time (weekdays, 8 hours each) it was booked, and who booked it most.
 */
export function roomUsage(roomId, from, to) {
  const list = bookingsOf(roomId, from, to).map((b) => ({ ...b, start: Math.max(b.start, from), end: Math.min(b.end, to) })).filter((b) => b.end > b.start);
  let booked = 0, until = -Infinity;
  for (const b of list) { const s = Math.max(b.start, until); if (b.end > s) booked += b.end - s; until = Math.max(until, b.end); }
  let weekdays = 0;
  for (let d = new Date(from); d.getTime() < to; d = new Date(d.getTime() + 864e5)) if (d.getUTCDay() % 6 !== 0) weekdays++;
  const by = new Map();
  for (const b of list) by.set(b.organizer, (by.get(b.organizer) || 0) + 1);
  const top = [...by].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([name, n]) => ({ name, bookings: n }));
  return { bookings: list.length, hours: Math.round(booked / 36e4) / 10, share: weekdays ? Math.min(100, Math.round((booked / (weekdays * 8 * 36e5)) * 100)) : 0, top };
}
export const USAGE_DAYS = [7, 30, 90];

export const QUICK_MINUTES = [15, 30, 45, 60, 90, 120];

export default function roomRoutes() {
  const r = Router();
  // Everything that's in some room of the company (to choose what a meeting needs), A to Z, each once.
  r.get('/features', (req, res) => {
    const seen = new Map();
    for (const room of q('SELECT features FROM rooms WHERE org_id = ?').all(req.user.org_id)) for (const f of JSON.parse(room.features || '[]')) if (!seen.has(f.toLowerCase())) seen.set(f.toLowerCase(), f);
    res.json([...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  });
  // Your company's rooms (with ?needs=, only those with all of it); with ?start&end (an event's time), whether each is free then.
  r.get('/', (req, res) => {
    const needs = needsOf(req);
    const list = q(`${ROOM} WHERE org_id = ? ORDER BY name COLLATE NOCASE`).all(req.user.org_id).map(outRoom).filter((room) => hasAll(room, needs));
    const start = Number(req.query.start), end = Number(req.query.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const except = String(req.query.event || '');
      for (const room of list) { const by = clash(room.id, except, [{ start, end }]); room.free = !by; }
    }
    res.json(list);
  });
  // A room's bookings between two times (at most 31 days): when, what and who booked it (rooms are
  // shared by the company, so its bookings are no secret inside it).
  r.get('/:id/busy', (req, res) => {
    const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!room) throw notFound();
    const from = Number(req.query.from), to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * 864e5) throw bad('Give from and to, at most 31 days apart');
    res.json(bookingsOf(room.id, from, to));
  });
  // The rooms board: every room, free or busy right now, and until when.
  r.get('/now', (req, res) => {
    const t = Date.now();
    const needs = needsOf(req);
    res.json(q(`${ROOM} WHERE org_id = ? ORDER BY name COLLATE NOCASE`).all(req.user.org_id).map(outRoom).filter((room) => hasAll(room, needs)).map((room) => {
      const { busy, next, current } = roomNow(room.id, t);
      // Yours (a one-off meeting you organise): you can end it now or run on.
      const mine = !!current && current.owner_id === req.user.id && !current.repeating;
      return { ...room, busy: busy && { ...busy, mine }, next };
    }));
  });
  // Walk-up booking: the room from now for 15 minutes to 2 hours (less if it's booked sooner), as an
  // event of yours with the room in it.
  r.post('/:id/book-now', (req, res) => {
    const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!room) throw notFound();
    const minutes = Number(req.body.minutes ?? 30);
    if (!QUICK_MINUTES.includes(minutes)) throw bad(`Book it for ${QUICK_MINUTES.join(', ')} minutes`);
    const start = Math.floor(Date.now() / 60000) * 60000;
    const state = roomNow(room.id, start);
    if (state.busy) throw new HttpError(409, `${room.name} is in use right now (${state.busy.title})`);
    const end = Math.min(start + minutes * 60000, state.next?.start ?? Infinity);
    if (end - start < 10 * 60000) throw new HttpError(409, `${room.name} is booked in a few minutes`);
    const title = str(req.body.title, { name: 'Title', max: 200 }) || `Meeting in ${room.name}`;
    const id = uid();
    tx(() => {
      q(`INSERT INTO events (id, owner_id, title, description, start, end, all_day, exdates, tz) VALUES (?, ?, ?, '', ?, ?, 0, '[]', ?)`)
        .run(id, req.user.id, title, start, end, String(req.body.tz || 'UTC').slice(0, 64));
      q("INSERT INTO event_rooms (event_id, room_id, status) VALUES (?, ?, 'yes')").run(id, room.id);
    });
    touch([req.user.id]);
    res.status(201).json({ id, title, start, end, shortened: end < start + minutes * 60000 });
  });
  // Your meeting in the room right now (a one-off one you organise): end it now, giving the room
  // back, or run on for longer when nobody has the room after it.
  const myCurrent = (req) => {
    const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!room) throw notFound();
    const t = Date.now();
    const cur = roomNow(room.id, t).current;
    if (!cur || cur.owner_id !== req.user.id) throw new HttpError(409, `You don’t have ${room.name} right now`);
    if (cur.repeating) throw bad('That’s a repeating meeting: change it in the calendar');
    return { room, cur, t };
  };
  const moved = (eventId, end) => {
    q('UPDATE events SET end = ? WHERE id = ?').run(end, eventId);
    touch([q('SELECT owner_id FROM events WHERE id = ?').get(eventId).owner_id, ...q('SELECT user_id FROM event_guests WHERE event_id = ?').all(eventId).map((g) => g.user_id)]);
    return { id: eventId, end };
  };
  r.post('/:id/end-now', (req, res) => {
    const { cur, t } = myCurrent(req);
    const minute = Math.floor(t / 60000) * 60000; // on the minute, unless it only just started
    res.json(moved(cur.event_id, minute > cur.start ? minute : t));
  });
  r.post('/:id/extend', (req, res) => {
    const { room, cur } = myCurrent(req);
    const minutes = Number(req.body.minutes ?? 15);
    if (![15, 30, 60].includes(minutes)) throw bad('Run on for 15, 30 or 60 minutes');
    const end = cur.end + minutes * 60000;
    const by = clash(room.id, cur.event_id, [{ start: cur.end, end }]);
    if (by) throw new HttpError(409, `${room.name} is booked after you: ${by}`);
    res.json(moved(cur.event_id, end));
  });

  // Admins: how much each room was used over the last 7, 30 or 90 days, busiest first.
  r.get('/usage', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only a company admin can see room usage');
    const days = Number(req.query.days || 30);
    if (!USAGE_DAYS.includes(days)) throw bad('Look back 7, 30 or 90 days');
    const to = Date.now(), from = to - days * 864e5;
    const list = q(`${ROOM} WHERE org_id = ?`).all(req.user.org_id).map(outRoom).map((room) => ({ id: room.id, name: room.name, capacity: room.capacity, ...roomUsage(room.id, from, to) }));
    res.json({ days, from, to, rooms: list.sort((x, y) => y.hours - x.hours || x.name.localeCompare(y.name)) });
  });
  const admin = (req) => { if (!req.user.is_admin) throw forbidden('Only a company admin can change rooms'); };
  const read = (b, cur = {}) => ({
    name: str(b.name ?? cur.name, { required: true, name: 'Name', max: 100 }),
    location: b.location === undefined ? cur.location ?? null : str(b.location, { name: 'Where it is', max: 100 }) || null,
    features: b.features === undefined ? JSON.parse(cur.features || '[]') : cleanFeatures(b.features),
    capacity: b.capacity === undefined ? cur.capacity ?? null : b.capacity === null || b.capacity === '' ? null : (() => { const n = Number(b.capacity); if (!Number.isInteger(n) || n < 1 || n > 10000) throw bad('Capacity: a number of people'); return n; })(),
  });
  r.post('/', (req, res) => {
    admin(req);
    const v = read(req.body);
    if (q('SELECT COUNT(*) AS n FROM rooms WHERE org_id = ?').get(req.user.org_id).n >= 200) throw bad('At most 200 rooms');
    const id = uid();
    q('INSERT INTO rooms (id, org_id, name, capacity, location, features, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.org_id, v.name, v.capacity, v.location, JSON.stringify(v.features), now());
    res.status(201).json(outRoom(q(`${ROOM} WHERE id = ?`).get(id)));
  });
  const own = (req) => { const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id); if (!room) throw notFound(); return room; };
  r.patch('/:id', (req, res) => {
    admin(req);
    const room = own(req);
    const v = read(req.body, room);
    q('UPDATE rooms SET name = ?, capacity = ?, location = ?, features = ? WHERE id = ?').run(v.name, v.capacity, v.location, JSON.stringify(v.features), room.id);
    res.json(outRoom(q(`${ROOM} WHERE id = ?`).get(room.id)));
  });
  r.delete('/:id', (req, res) => {
    admin(req);
    q('DELETE FROM rooms WHERE id = ?').run(own(req).id);
    res.json({ ok: true });
  });
  return r;
}
