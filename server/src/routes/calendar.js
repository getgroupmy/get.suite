import { Router } from 'express';
import { q } from '../db.js';
import { uid, str, int, bad, notFound } from '../util.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

/**
 * A repeat rule: { freq, interval?, byday? (weekly: 0=Sun..6), until? (ms), count? }. The
 * browser works out the dates in the user's local time; the server only checks the rule.
 */
function readRule(rule) {
  if (rule === null || rule === undefined || rule === '') return null;
  if (typeof rule !== 'object' || !FREQS.includes(rule.freq)) throw bad('Unknown repeat rule');
  const out = { freq: rule.freq };
  const interval = rule.interval === undefined ? 1 : Number(rule.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw bad('Repeat every 1 to 99');
  if (interval !== 1) out.interval = interval;
  if (rule.byday !== undefined) {
    if (rule.freq !== 'weekly') throw bad('Weekdays only apply to weekly repeats');
    const days = [...new Set([].concat(rule.byday).map(Number))].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Pick at least one weekday');
    out.byday = days;
  }
  if (rule.until !== undefined && rule.until !== null) out.until = int(rule.until, 'until');
  if (rule.count !== undefined && rule.count !== null) {
    const n = Number(rule.count);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw bad('Repeat 1 to 999 times');
    out.count = n;
  }
  if (out.until !== undefined && out.count !== undefined) throw bad('Choose an end date or a number of times, not both');
  return out;
}
const readExdates = (list) => {
  if (!Array.isArray(list)) throw bad('Invalid skipped dates');
  return [...new Set(list.map((x) => int(x, 'exdate')))].slice(-1000);
};

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
  if (body.rrule !== undefined) e.rrule = readRule(body.rrule);
  if (body.exdates !== undefined) e.exdates = readExdates(body.exdates);
  if (e.end < e.start) throw bad('End must be after start');
  if (e.rrule?.until !== undefined && e.rrule.until < e.start) throw bad('The repeat ends before the event starts');
  return e;
}

const outEvent = (row) => ({ ...row, rrule: row.rrule ? JSON.parse(row.rrule) : null, exdates: JSON.parse(row.exdates || '[]'), repeat_until: undefined });
// When a series ends, for the range query: its last possible end (null = never, or "after N times").
const repeatUntil = (e) => (e.rrule ? (e.rrule.until !== undefined ? e.rrule.until + (e.end - e.start) : null) : null);

export default function calendarRoutes() {
  const r = Router();

  // Events overlapping [from, to)
  r.get('/', (req, res) => {
    const from = int(req.query.from ?? 0, 'from');
    const to = int(req.query.to ?? 8.64e15, 'to');
    // Repeating events count from their first date; the browser expands them in local time.
    const rows = q(`SELECT * FROM events WHERE owner_id = ? AND start < ?
                    AND (end >= ? OR (rrule IS NOT NULL AND (repeat_until IS NULL OR repeat_until >= ?))) ORDER BY start`)
      .all(req.user.id, to, from, from);
    res.json(rows.map(outEvent));
  });

  r.post('/', (req, res) => {
    const e = readEvent(req.body);
    const id = uid();
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, e.title, e.description ?? null, e.location ?? null, e.start, e.end, e.all_day ?? 0, e.color ?? null,
        e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e));
    res.status(201).json(outEvent(q('SELECT * FROM events WHERE id = ?').get(id)));
  });

  r.patch('/:id', (req, res) => {
    const existing = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!existing) throw notFound();
    const e = readEvent(req.body, outEvent(existing));
    q(`UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, color = ?, rrule = ?, exdates = ?, repeat_until = ? WHERE id = ?`)
      .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.color, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), e.id);
    res.json(outEvent(q('SELECT * FROM events WHERE id = ?').get(e.id)));
  });

  r.delete('/:id', (req, res) => {
    const info = q('DELETE FROM events WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) throw notFound();
    res.json({ ok: true });
  });

  return r;
}
