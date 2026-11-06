// Reminders for calendar events: each person's own (minutes before the start), for events they
// organise and ones they're invited to. The web app shows them; phones get them as VALARMs.
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS event_reminders (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id, minutes)
)`).run();
q('CREATE INDEX IF NOT EXISTS event_reminders_user ON event_reminders(user_id)').run();

export const MAX_REMINDERS = 5;
export const MAX_MINUTES = 4 * 7 * 24 * 60; // four weeks before

/** A clean list of reminders: whole minutes before the start, 0 (at the start) to four weeks, each once. */
export function readReminders(list) {
  if (!Array.isArray(list)) return [];
  const out = [...new Set(list.map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= MAX_MINUTES))].sort((a, b) => a - b);
  return out.slice(0, MAX_REMINDERS);
}

export const remindersOf = (eventId, userId) => q('SELECT minutes FROM event_reminders WHERE event_id = ? AND user_id = ? ORDER BY minutes').all(eventId, userId).map((r) => r.minutes);

/** Everyone's reminders of these events for one person: event id → [minutes]. */
export function remindersFor(userId, eventIds) {
  const map = new Map();
  if (!eventIds.length) return map;
  for (const r of q('SELECT event_id, minutes FROM event_reminders WHERE user_id = ? AND event_id IN (SELECT value FROM json_each(?)) ORDER BY minutes').all(userId, JSON.stringify(eventIds))) {
    if (!map.has(r.event_id)) map.set(r.event_id, []);
    map.get(r.event_id).push(r.minutes);
  }
  return map;
}

export function setReminders(eventId, userId, list) {
  const clean = readReminders(list);
  q('DELETE FROM event_reminders WHERE event_id = ? AND user_id = ?').run(eventId, userId);
  for (const m of clean) q('INSERT INTO event_reminders (event_id, user_id, minutes) VALUES (?, ?, ?)').run(eventId, userId, m);
  return clean;
}
