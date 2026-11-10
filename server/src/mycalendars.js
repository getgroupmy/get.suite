// Calendars of your own besides your main one: Personal, Family, a project… Each has a name and a
// colour (new events in it take that colour, and recolouring it recolours the events still in its
// old colour), can be hidden from view, and can be imported into, downloaded or deleted with its
// events. Everyone else sees the events as part of your calendar (free/busy, sharing, invitations).
import { q } from './db.js';
import { uid, bad, notFound } from './util.js';

export const MAX_CALENDARS = 20;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const out = (c) => ({ id: c.id, name: c.name, color: c.color, hidden: !!c.hidden, events: q('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ? AND owner_id = ? AND recur_parent IS NULL').get(c.id, c.owner_id).n });

export const calendarsOf = (userId) => q('SELECT * FROM user_calendars WHERE owner_id = ? ORDER BY created_at, name').all(userId).map(out);
export function ownCalendar(userId, id) {
  const c = q('SELECT * FROM user_calendars WHERE id = ? AND owner_id = ?').get(String(id || ''), userId);
  if (!c) throw notFound('Calendar not found');
  return c;
}
/** The calendar an event goes in: null for the main one, or one of yours (checked). */
export const calendarFor = (userId, id) => (id === null || id === '' || id === undefined ? null : ownCalendar(userId, id).id);

const cleanName = (n) => {
  const name = String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw bad('Give the calendar a name');
  return name;
};
const cleanColor = (c) => { if (!COLOR_RE.test(String(c || ''))) throw bad('Pick a colour'); return String(c).toLowerCase(); };

export function addCalendar(userId, { name, color } = {}) {
  if (q('SELECT COUNT(*) AS n FROM user_calendars WHERE owner_id = ?').get(userId).n >= MAX_CALENDARS) throw bad(`At most ${MAX_CALENDARS} calendars`);
  const n = cleanName(name);
  if (q('SELECT 1 FROM user_calendars WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(userId, n)) throw bad(`You already have a calendar called “${n}”`);
  const id = uid();
  q('INSERT INTO user_calendars (id, owner_id, name, color, hidden, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(id, userId, n, cleanColor(color || '#0b8043'), Date.now());
  return out(ownCalendar(userId, id));
}

export function changeCalendar(userId, id, body = {}) {
  const c = ownCalendar(userId, id);
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (q('SELECT 1 FROM user_calendars WHERE owner_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(userId, n, c.id)) throw bad(`You already have a calendar called “${n}”`);
    q('UPDATE user_calendars SET name = ? WHERE id = ?').run(n, c.id);
  }
  if (body.color !== undefined) {
    const color = cleanColor(body.color);
    // Events still in the calendar's colour follow it; ones given their own colour keep it.
    q('UPDATE events SET color = ? WHERE calendar_id = ? AND owner_id = ? AND (color IS NULL OR LOWER(color) = LOWER(?))').run(color, c.id, userId, c.color);
    q('UPDATE user_calendars SET color = ? WHERE id = ?').run(color, c.id);
  }
  if (body.hidden !== undefined) q('UPDATE user_calendars SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, c.id);
  return out(ownCalendar(userId, c.id));
}

/** The calendar's events (series, not their changed occurrences, which go with them). */
export const eventsIn = (userId, id) => q('SELECT * FROM events WHERE calendar_id = ? AND owner_id = ? AND recur_parent IS NULL').all(id, userId);
