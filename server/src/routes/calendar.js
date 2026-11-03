import { Router } from 'express';
import { q } from '../db.js';
import { uid, str, int, bad, notFound } from '../util.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function readEvent(body, existing = {}) {
  const e = { ...existing };
  if (body.title !== undefined || !existing.id) e.title = str(body.title, { required: true, name: 'Title', max: 200 });
  if (body.description !== undefined) e.description = str(body.description, { max: 5000 });
  if (body.location !== undefined) e.location = str(body.location, { max: 300 });
  if (body.start !== undefined || !existing.id) e.start = int(body.start, 'start');
  if (body.end !== undefined || !existing.id) e.end = int(body.end, 'end');
  if (body.all_day !== undefined) e.all_day = body.all_day ? 1 : 0;
  if (body.color !== undefined) {
    if (body.color && !COLOR_RE.test(body.color)) throw bad('Invalid color');
    e.color = body.color || null;
  }
  if (e.end < e.start) throw bad('End must be after start');
  return e;
}

export default function calendarRoutes() {
  const r = Router();

  // Events overlapping [from, to)
  r.get('/', (req, res) => {
    const from = int(req.query.from ?? 0, 'from');
    const to = int(req.query.to ?? 8.64e15, 'to');
    res.json(q('SELECT * FROM events WHERE owner_id = ? AND start < ? AND end >= ? ORDER BY start').all(req.user.id, to, from));
  });

  r.post('/', (req, res) => {
    const e = readEvent(req.body);
    const id = uid();
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, e.title, e.description ?? null, e.location ?? null, e.start, e.end, e.all_day ?? 0, e.color ?? null);
    res.status(201).json(q('SELECT * FROM events WHERE id = ?').get(id));
  });

  r.patch('/:id', (req, res) => {
    const existing = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!existing) throw notFound();
    const e = readEvent(req.body, existing);
    q(`UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, color = ? WHERE id = ?`)
      .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.color, e.id);
    res.json(q('SELECT * FROM events WHERE id = ?').get(e.id));
  });

  r.delete('/:id', (req, res) => {
    const info = q('DELETE FROM events WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) throw notFound();
    res.json({ ok: true });
  });

  return r;
}
