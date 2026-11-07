// Meeting rooms (and other things to book, like a projector): a company's admins list them; people
// add one to an event, and it's booked when it's free then (every time, for a repeating event, over
// the next six months) or declined when something else has it.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { expand } from '../calmath.js';
import { outEvent } from './calendar.js';

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

export default function roomRoutes() {
  const r = Router();
  // Your company's rooms; with ?start&end (an event's time), whether each is free then.
  r.get('/', (req, res) => {
    const list = q('SELECT id, name, capacity FROM rooms WHERE org_id = ? ORDER BY name COLLATE NOCASE').all(req.user.org_id);
    const start = Number(req.query.start), end = Number(req.query.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const except = String(req.query.event || '');
      for (const room of list) { const by = clash(room.id, except, [{ start, end }]); room.free = !by; }
    }
    res.json(list);
  });
  const admin = (req) => { if (!req.user.is_admin) throw forbidden('Only a company admin can change rooms'); };
  const read = (b, cur = {}) => ({
    name: str(b.name ?? cur.name, { required: true, name: 'Name', max: 100 }),
    capacity: b.capacity === undefined ? cur.capacity ?? null : b.capacity === null || b.capacity === '' ? null : (() => { const n = Number(b.capacity); if (!Number.isInteger(n) || n < 1 || n > 10000) throw bad('Capacity: a number of people'); return n; })(),
  });
  r.post('/', (req, res) => {
    admin(req);
    const v = read(req.body);
    if (q('SELECT COUNT(*) AS n FROM rooms WHERE org_id = ?').get(req.user.org_id).n >= 200) throw bad('At most 200 rooms');
    const id = uid();
    q('INSERT INTO rooms (id, org_id, name, capacity, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.org_id, v.name, v.capacity, now());
    res.status(201).json(q('SELECT id, name, capacity FROM rooms WHERE id = ?').get(id));
  });
  const own = (req) => { const room = q('SELECT * FROM rooms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id); if (!room) throw notFound(); return room; };
  r.patch('/:id', (req, res) => {
    admin(req);
    const room = own(req);
    const v = read(req.body, room);
    q('UPDATE rooms SET name = ?, capacity = ? WHERE id = ?').run(v.name, v.capacity, room.id);
    res.json(q('SELECT id, name, capacity FROM rooms WHERE id = ?').get(room.id));
  });
  r.delete('/:id', (req, res) => {
    admin(req);
    q('DELETE FROM rooms WHERE id = ?').run(own(req).id);
    res.json({ ok: true });
  });
  return r;
}
