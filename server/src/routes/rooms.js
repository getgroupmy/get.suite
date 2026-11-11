// Meeting rooms (and other things to book, like a projector): a company's admins list them; people
// add one to an event, and it's booked when it's free then (every time, for a repeating event, over
// the next six months) or declined when something else has it.
import express, { Router } from 'express';
import { parseCsv } from '../contactfiles.js';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError } from '../util.js';
import { expand } from '../calmath.js';
import { outEvent, touch } from './calendar.js';
import { notify } from '../notifications.js';

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
// admins_only: only the company's admins can book it (a boardroom, the company car); others are declined.
for (const [col, type] of [['location', 'TEXT'], ['features', "TEXT NOT NULL DEFAULT '[]'"], ['admins_only', 'INTEGER NOT NULL DEFAULT 0'], ['check_in', 'INTEGER NOT NULL DEFAULT 0']]) {
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
const ROOM = 'SELECT id, name, capacity, location, features, admins_only, check_in FROM rooms';
const outRoom = (r) => r && { ...r, features: JSON.parse(r.features || '[]'), admins_only: !!r.admins_only, check_in: !!r.check_in };
/** May this person book the room? */
const mayBook = (room, user) => !room.admins_only || !!user.is_admin;
/** ?needs=Video,Whiteboard: rooms that have all of these (ignoring case). */
const needsOf = (req) => String(req.query.needs || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, MAX_FEATURES);
const hasAll = (room, needs) => needs.every((n) => room.features.some((f) => f.toLowerCase() === n));

// Check-in (rooms with check_in): someone from the meeting checks in during its first minutes, or the
// room is released for that time (one occurrence of a repeating meeting at a time) and others can book it.
q(`CREATE TABLE IF NOT EXISTS room_checkins (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,           -- the occurrence
  released INTEGER NOT NULL DEFAULT 0,  -- 0: checked in; 1: nobody did, the room went back
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, event_id, start)
)`).run();
export const CHECK_IN_MINUTES = 10;
// Who was asked to check in (once per occurrence), so the reminder isn't sent twice.
q(`CREATE TABLE IF NOT EXISTS room_checkin_asks (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  PRIMARY KEY (room_id, event_id, start)
)`).run();
const releasedSet = (roomId) => new Set(q('SELECT event_id, start FROM room_checkins WHERE room_id = ? AND released = 1').all(roomId).map((r) => `${r.event_id}:${r.start}`));

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
  const gone = releasedSet(roomId);
  for (const o of others) {
    const busy = timesOf(outEvent(o), from - 864e5).filter((b) => b.start < to && b.end > from && !gone.has(`${o.id}:${b.start}`));
    if (busy.some((b) => times.some((t) => b.start < t.end && b.end > t.start))) return o.title;
  }
  return null;
}

/** An event's rooms: [{ id, name, status }]. */
export const roomsOf = (eventId) => q(`SELECT r.id, r.name, er.status, r.admins_only FROM event_rooms er JOIN rooms r ON r.id = er.room_id WHERE er.event_id = ? ORDER BY r.name`).all(eventId).map((r) => ({ ...r, admins_only: !!r.admins_only }));

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
    for (const r of rooms) q('INSERT INTO event_rooms (event_id, room_id, status) VALUES (?, ?, ?)').run(ev.id, r.id, !mayBook(r, user) || clash(r.id, ev.id, times) ? 'no' : 'yes');
  });
  return roomsOf(ev.id);
}

/** A room's bookings that overlap from–to (repeats expanded): [{ start, end, title, organizer }], soonest first. */
function bookingsOf(roomId, from, to) {
  const rows = q(`SELECT e.*, u.name AS organizer FROM events e JOIN event_rooms r ON r.event_id = e.id JOIN users u ON u.id = e.owner_id
                  WHERE r.room_id = ? AND r.status = 'yes' AND e.start < ?
                    AND (e.end > ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?)))`).all(roomId, to, from, from);
  const gone = releasedSet(roomId);
  return rows.flatMap((row) => expand(outEvent(row), from, to).filter((o) => !gone.has(`${row.id}:${o.start}`)).map((o) => ({ start: o.start, end: o.end, title: row.title, organizer: row.organizer, event_id: row.id, owner_id: row.owner_id, repeating: !!row.rrule })))
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
  const done = q('SELECT 1 FROM room_checkins WHERE room_id = ? AND event_id = ? AND start = ?').get(roomId, on.event_id, on.start);
  const needs = !!q('SELECT check_in FROM rooms WHERE id = ?').get(roomId)?.check_in;
  return { busy: { title: on.title, organizer: on.organizer, until, checked_in: !!done, release_at: needs && !done ? on.start + CHECK_IN_MINUTES * 60000 : null }, next: n ? { start: n.start, title: n.title } : null, current: on };
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
  // Bookings released because nobody checked in (rooms with check-in): booked, then not used.
  const noShows = q('SELECT COUNT(*) AS n FROM room_checkins WHERE room_id = ? AND released = 1 AND start >= ? AND start < ?').get(roomId, from, to).n;
  return { no_shows: noShows, bookings: list.length, hours: Math.round(booked / 36e4) / 10, share: weekdays ? Math.min(100, Math.round((booked / (weekdays * 8 * 36e5)) * 100)) : 0, top };
}
export const USAGE_DAYS = [7, 30, 90];

/**
 * Rooms with check-in: meetings that started CHECK_IN_MINUTES ago (or more, within the hour) with
 * nobody checked in lose the room for that time; the organizer is told. Returns how many were released.
 */
export function releaseNoShows(t = Date.now()) {
  let n = 0;
  for (const room of q('SELECT id, name FROM rooms WHERE check_in = 1').all()) {
    for (const b of bookingsOf(room.id, t - 36e5, t)) {
      if (b.start > t - CHECK_IN_MINUTES * 60000 || b.start < t - 36e5 || b.end <= t) continue;
      if (q('SELECT 1 FROM room_checkins WHERE room_id = ? AND event_id = ? AND start = ?').get(room.id, b.event_id, b.start)) continue;
      q('INSERT INTO room_checkins (room_id, event_id, start, released, at) VALUES (?, ?, ?, 1, ?)').run(room.id, b.event_id, b.start, t);
      notify([b.owner_id], { kind: 'invite', title: `${room.name} was released`, body: `Nobody checked in to “${b.title}” in its first ${CHECK_IN_MINUTES} minutes, so others can book the room now.`, link: '/calendar' });
      touch([b.owner_id]);
      n++;
    }
  }
  return n;
}

/**
 * Rooms with check-in: when a meeting there starts, its organizer and the guests coming are asked (in
 * the bell, once) to check in; the link opens Rooms now. Returns how many meetings were asked about.
 */
export function askCheckIns(t = Date.now()) {
  let n = 0;
  for (const room of q('SELECT id, name FROM rooms WHERE check_in = 1').all()) {
    for (const b of bookingsOf(room.id, t, t + 1)) {
      if (b.start > t || b.start <= t - CHECK_IN_MINUTES * 60000) continue; // only in its first minutes
      if (q('SELECT 1 FROM room_checkins WHERE room_id = ? AND event_id = ? AND start = ?').get(room.id, b.event_id, b.start)) continue;
      if (!q('INSERT OR IGNORE INTO room_checkin_asks (room_id, event_id, start) VALUES (?, ?, ?)').run(room.id, b.event_id, b.start).changes) continue;
      const people = [b.owner_id, ...q("SELECT user_id FROM event_guests WHERE event_id = ? AND status IN ('yes', 'maybe')").all(b.event_id).map((g) => g.user_id)];
      notify([...new Set(people)], { kind: 'invite', title: `Check in to ${room.name}`, body: `“${b.title}” has started. Someone check in within ${CHECK_IN_MINUTES} minutes of the start, or the room is released for others.`, link: '/calendar?rooms=now' });
      n++;
    }
  }
  return n;
}

/**
 * Rooms from a spreadsheet saved as CSV: a header row with Name (needed), and any of Seats (or Capacity),
 * Where (or Location) and Equipment (several, with commas). { rooms: [{ name, capacity, location, features }],
 * problems: ['Line 4: …'] }.
 */
export function roomsFromCsv(text) {
  const rows = parseCsv(text, { keepEmpty: true });
  const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const at = { name: col('name', 'room', 'room name'), capacity: col('seats', 'capacity', 'people'), location: col('where', 'location', 'floor'), features: col('equipment', 'features', 'facilities') };
  if (at.name < 0) return { rooms: [], problems: ['The first row needs a Name column'] };
  const rooms = [], problems = [];
  rows.slice(1).forEach((r, i) => {
    if (!r.some((f) => f.trim())) return;
    const line = i + 2;
    const name = (r[at.name] || '').trim().replace(/\s+/g, ' ');
    if (!name) { problems.push(`Line ${line}: no name`); return; }
    if (name.length > 100) { problems.push(`Line ${line}: the name is too long`); return; }
    // A column the file doesn't have is left out (undefined): an existing room keeps what it had.
    const seats = at.capacity >= 0 ? (r[at.capacity] || '').trim() : undefined;
    const capacity = seats === undefined ? undefined : seats === '' ? null : Number(seats);
    if (capacity != null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000)) { problems.push(`Line ${line}: seats should be a number of people`); return; }
    const location = at.location >= 0 ? (r[at.location] || '').trim().slice(0, 100) || null : undefined;
    let features;
    try { features = at.features >= 0 ? cleanFeatures((r[at.features] || '').split(/[,;|]/)) : undefined; } catch (e) { problems.push(`Line ${line}: ${e.message}`); return; }
    rooms.push({ name, capacity, location, features });
  });
  return { rooms, problems };
}
const csvCell = (v) => (/[",\n;]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

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
    for (const room of list) room.can_book = mayBook(room, req.user);
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
      return { ...room, busy: busy && { ...busy, mine }, next, can_book: mayBook(room, req.user) };
    }));
  });
  // Walk-up booking: the room from now for 15 minutes to 2 hours (less if it's booked sooner), as an
  // event of yours with the room in it.
  r.post('/:id/book-now', (req, res) => {
    const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!room) throw notFound();
    if (!mayBook(room, req.user)) throw forbidden(`Only admins can book ${room.name}`);
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
  // Check in to the meeting in the room now: its organizer or a guest (in the room, so it's kept).
  r.post('/:id/check-in', (req, res) => {
    const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!room) throw notFound();
    const t = Date.now();
    const cur = roomNow(room.id, t).current;
    const inIt = cur && (cur.owner_id === req.user.id || q("SELECT 1 FROM event_guests WHERE event_id = ? AND user_id = ? AND status != 'no'").get(cur.event_id, req.user.id));
    if (!inIt) throw new HttpError(409, `You’re not in the meeting in ${room.name} right now`);
    q('INSERT OR IGNORE INTO room_checkins (room_id, event_id, start, released, at) VALUES (?, ?, ?, 0, ?)').run(room.id, cur.event_id, cur.start, t);
    res.json({ ok: true, title: cur.title });
  });
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
  // Admins: add or update rooms from a CSV file (a room with the same name, ignoring case, is updated).
  r.post('/import', express.text({ type: () => true, limit: '2mb' }), (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only a company admin can change rooms');
    const { rooms, problems } = roomsFromCsv(typeof req.body === 'string' ? req.body : '');
    if (!rooms.length) throw bad(problems[0] || 'No rooms in that file');
    let added = 0, updated = 0;
    tx(() => {
      for (const v of rooms) {
        const cur = q('SELECT * FROM rooms WHERE org_id = ? AND lower(name) = lower(?)').get(req.user.org_id, v.name);
        if (cur) {
          q('UPDATE rooms SET name = ?, capacity = ?, location = ?, features = ? WHERE id = ?').run(v.name, v.capacity === undefined ? cur.capacity : v.capacity,
            v.location === undefined ? cur.location : v.location, v.features === undefined ? cur.features : JSON.stringify(v.features), cur.id);
          updated++; continue;
        }
        if (q('SELECT COUNT(*) AS n FROM rooms WHERE org_id = ?').get(req.user.org_id).n >= 200) { problems.push(`${v.name}: at most 200 rooms`); continue; }
        q('INSERT INTO rooms (id, org_id, name, capacity, location, features, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid(), req.user.org_id, v.name, v.capacity ?? null, v.location ?? null, JSON.stringify(v.features ?? []), now());
        added++;
      }
    });
    res.json({ added, updated, problems });
  });
  // Every room as a CSV file (the same columns import takes).
  r.get('/export.csv', (req, res) => {
    const rows = q(`${ROOM} WHERE org_id = ? ORDER BY name COLLATE NOCASE`).all(req.user.org_id).map(outRoom);
    const csv = ['Name,Seats,Where,Equipment', ...rows.map((x) => [x.name, x.capacity ?? '', x.location ?? '', x.features.join(', ')].map(csvCell).join(','))].join('\r\n') + '\r\n';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rooms.csv"' }).send(csv);
  });
  const admin = (req) => { if (!req.user.is_admin) throw forbidden('Only a company admin can change rooms'); };
  const read = (b, cur = {}) => ({
    name: str(b.name ?? cur.name, { required: true, name: 'Name', max: 100 }),
    location: b.location === undefined ? cur.location ?? null : str(b.location, { name: 'Where it is', max: 100 }) || null,
    features: b.features === undefined ? JSON.parse(cur.features || '[]') : cleanFeatures(b.features),
    check_in: b.check_in === undefined ? cur.check_in ? 1 : 0 : b.check_in ? 1 : 0,
    admins_only: b.admins_only === undefined ? cur.admins_only ? 1 : 0 : b.admins_only ? 1 : 0,
    capacity: b.capacity === undefined ? cur.capacity ?? null : b.capacity === null || b.capacity === '' ? null : (() => { const n = Number(b.capacity); if (!Number.isInteger(n) || n < 1 || n > 10000) throw bad('Capacity: a number of people'); return n; })(),
  });
  r.post('/', (req, res) => {
    admin(req);
    const v = read(req.body);
    if (q('SELECT COUNT(*) AS n FROM rooms WHERE org_id = ?').get(req.user.org_id).n >= 200) throw bad('At most 200 rooms');
    const id = uid();
    q('INSERT INTO rooms (id, org_id, name, capacity, location, features, admins_only, check_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, req.user.org_id, v.name, v.capacity, v.location, JSON.stringify(v.features), v.admins_only, v.check_in, now());
    res.status(201).json(outRoom(q(`${ROOM} WHERE id = ?`).get(id)));
  });
  const own = (req) => { const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id); if (!room) throw notFound(); return room; };
  r.patch('/:id', (req, res) => {
    admin(req);
    const room = own(req);
    const v = read(req.body, room);
    q('UPDATE rooms SET name = ?, capacity = ?, location = ?, features = ?, admins_only = ?, check_in = ? WHERE id = ?').run(v.name, v.capacity, v.location, JSON.stringify(v.features), v.admins_only, v.check_in, room.id);
    res.json(outRoom(q(`${ROOM} WHERE id = ?`).get(room.id)));
  });
  r.delete('/:id', (req, res) => {
    admin(req);
    q('DELETE FROM rooms WHERE id = ?').run(own(req).id);
    res.json({ ok: true });
  });
  return r;
}
