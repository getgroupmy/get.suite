// Working location: where you work each weekday (the office, home or somewhere else), changed for a
// particular day when plans differ. Colleagues see where people are on a day (the Directory shows
// today). Mounted at /api/location.
import { Router } from 'express';
import { q } from '../db.js';
import { str, bad } from '../util.js';
import { sendTo } from '../hub.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'workloc_week')) q('ALTER TABLE users ADD COLUMN workloc_week TEXT').run();
q(`CREATE TABLE IF NOT EXISTS work_locations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,          -- YYYY-MM-DD
  place TEXT NOT NULL,         -- office | home | other
  label TEXT,                  -- "Client site", "Berlin office"…
  PRIMARY KEY (user_id, date)
)`).run();

export const PLACES = ['office', 'home', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const weekOf = (userId) => { try { return JSON.parse(q('SELECT workloc_week FROM users WHERE id = ?').get(userId)?.workloc_week || '{}'); } catch { return {}; } };
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday

/** Where someone is on a day: { place, label, from: 'day' | 'week' } or null when not set. */
export function placeOn(userId, date, week = weekOf(userId)) {
  const d = q('SELECT place, label FROM work_locations WHERE user_id = ? AND date = ?').get(userId, date);
  if (d) return { place: d.place, label: d.label || null, from: 'day' };
  const w = week[weekday(date)];
  return w ? { place: w.place || w, label: w.label || null, from: 'week' } : null;
}

/** Each day from..to (inclusive, at most 62). */
export function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 62) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export default function locationRoutes() {
  const r = Router();
  // Yours: { week: { 0..6: place }, days: { date: { place, label, from } } } for ?from=&to=.
  r.get('/', (req, res) => {
    const from = String(req.query.from || ''), to = String(req.query.to || from);
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw bad('from and to must be dates');
    const week = weekOf(req.user.id);
    res.json({ week, days: Object.fromEntries(daysBetween(from, to).map((d) => [d, placeOn(req.user.id, d, week)])) });
  });
  // Your usual week: { week: { 1: 'office', 5: 'home', … } } (0 = Sunday; missing or null: not set).
  r.put('/week', (req, res) => {
    const w = req.body?.week;
    if (!w || typeof w !== 'object') throw bad('week must be an object');
    const out = {};
    for (const [k, v] of Object.entries(w)) {
      if (!/^[0-6]$/.test(k)) throw bad('Days are 0 (Sunday) to 6 (Saturday)');
      if (v === null || v === '') continue;
      if (!PLACES.includes(v)) throw bad('Place must be office, home or other');
      out[k] = v;
    }
    q('UPDATE users SET workloc_week = ? WHERE id = ?').run(Object.keys(out).length ? JSON.stringify(out) : null, req.user.id);
    sendTo([req.user.id], { type: 'location-changed' });
    res.json({ week: out });
  });
  // One day different: { date, place, label } (place null: back to your usual week).
  r.put('/day', (req, res) => {
    const date = String(req.body?.date || '');
    if (!DAY_RE.test(date)) throw bad('date must be YYYY-MM-DD');
    const place = req.body?.place ?? null;
    if (place === null || place === '') q('DELETE FROM work_locations WHERE user_id = ? AND date = ?').run(req.user.id, date);
    else {
      if (!PLACES.includes(place)) throw bad('Place must be office, home or other');
      const label = str(req.body?.label ?? '', { max: 60 }) || null;
      q('INSERT INTO work_locations (user_id, date, place, label) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, date) DO UPDATE SET place = excluded.place, label = excluded.label')
        .run(req.user.id, date, place, label);
    }
    sendTo([req.user.id], { type: 'location-changed' });
    res.json({ date, ...(placeOn(req.user.id, date) || { place: null }) });
  });
  // Where colleagues are on a day: { userId: { place, label } } (those who've said).
  r.get('/people', (req, res) => {
    const date = String(req.query.date || '');
    if (!DAY_RE.test(date)) throw bad('date must be YYYY-MM-DD');
    const out = {};
    for (const u of q('SELECT id, workloc_week FROM users WHERE org_id = ? AND disabled = 0').all(req.user.org_id)) {
      let week = {};
      try { week = JSON.parse(u.workloc_week || '{}'); } catch { /* none */ }
      const p = placeOn(u.id, date, week);
      if (p) out[u.id] = { place: p.place, label: p.label };
    }
    res.json(out);
  });
  return r;
}
