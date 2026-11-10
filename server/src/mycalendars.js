// Calendars of your own besides your main one: Personal, Family, a project… Each has a name and a
// colour (new events in it take that colour, and recolouring it recolours the events still in its
// old colour), can be hidden from view, and can be imported into, downloaded or deleted with its
// events. Everyone else sees the events as part of your calendar (free/busy, sharing, invitations).
import { q } from './db.js';
import { uid, bad, notFound } from './util.js';

export const MAX_CALENDARS = 20;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const out = (c) => ({ id: c.id, name: c.name, color: c.color, hidden: !!c.hidden, events: q('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ? AND owner_id = ? AND recur_parent IS NULL').get(c.id, c.owner_id).n, members: membersOf(c.id) });

/** Who a calendar is shared with: [{ id, name, email, can_edit }]. */
export const membersOf = (calId) => q(`SELECT u.id, u.name, u.username AS email, s.can_edit FROM user_calendar_shares s JOIN users u ON u.id = s.user_id
  WHERE s.calendar_id = ? ORDER BY u.name`).all(calId).map((m) => ({ ...m, can_edit: !!m.can_edit }));
/** Calendars colleagues share with you: { id, name, color, hidden, shared: true, can_edit, owner: { id, name } }. */
export const sharedWith = (userId) => q(`SELECT c.id, c.name, c.color, s.hidden, s.can_edit, u.id AS owner_id, u.name AS owner_name FROM user_calendar_shares s
  JOIN user_calendars c ON c.id = s.calendar_id JOIN users u ON u.id = c.owner_id WHERE s.user_id = ? AND u.disabled = 0 ORDER BY c.name`).all(userId)
  .map((c) => ({ id: c.id, name: c.name, color: c.color, hidden: !!c.hidden, shared: true, can_edit: !!c.can_edit, owner: { id: c.owner_id, name: c.owner_name } }));
/** Your share of someone's calendar ({ calendar_id, can_edit, owner_id }), or null. */
export const shareOf = (userId, calId) => q('SELECT s.calendar_id, s.can_edit, c.owner_id FROM user_calendar_shares s JOIN user_calendars c ON c.id = s.calendar_id WHERE s.user_id = ? AND s.calendar_id = ?').get(userId, String(calId || '')) || null;
/** Everyone a calendar's events reach: its owner and its members. */
export const peopleOf = (calId) => (calId ? q('SELECT owner_id AS id FROM user_calendars WHERE id = ? UNION SELECT user_id FROM user_calendar_shares WHERE calendar_id = ?').all(calId, calId).map((r) => r.id) : []);

export const calendarsOf = (userId) => [...q('SELECT * FROM user_calendars WHERE owner_id = ? ORDER BY created_at, name').all(userId).map(out), ...sharedWith(userId)];
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

/**
 * Share a calendar with colleagues ([{ id, can_edit }]; the whole list): `canShareWith(id)` says who may be added.
 * Gives { added: [ids] } so they can be told.
 */
export function setMembers(userId, calId, list, canShareWith) {
  const c = ownCalendar(userId, calId);
  if (!Array.isArray(list)) throw bad('members must be a list');
  if (list.length > 100) throw bad('At most 100 people');
  const want = new Map();
  for (const m of list) {
    const id = String(m?.id || '');
    if (!id || id === userId) continue;
    if (!canShareWith(id)) throw bad('You can only share with people at your company');
    want.set(id, !!m.can_edit);
  }
  const before = new Set(q('SELECT user_id FROM user_calendar_shares WHERE calendar_id = ?').all(c.id).map((r) => r.user_id));
  for (const id of before) if (!want.has(id)) q('DELETE FROM user_calendar_shares WHERE calendar_id = ? AND user_id = ?').run(c.id, id);
  for (const [id, edit] of want) {
    if (before.has(id)) q('UPDATE user_calendar_shares SET can_edit = ? WHERE calendar_id = ? AND user_id = ?').run(edit ? 1 : 0, c.id, id);
    else q('INSERT INTO user_calendar_shares (calendar_id, user_id, can_edit, hidden, created_at) VALUES (?, ?, ?, 0, ?)').run(c.id, id, edit ? 1 : 0, Date.now());
  }
  return { calendar: c, added: [...want.keys()].filter((id) => !before.has(id)), removed: [...before].filter((id) => !want.has(id)) };
}

/** The calendar's events (series, not their changed occurrences, which go with them). */
export const eventsIn = (userId, id) => q('SELECT * FROM events WHERE calendar_id = ? AND owner_id = ? AND recur_parent IS NULL').all(id, userId);
