// Time off: ask for days off (Calendar → Request time off), and the person you report to (or, if you
// report to nobody, a company admin) approves or declines. Approved time off is an all-day out-of-office
// event on your calendar, so invitations for those days are declined for you as with any time off.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, bad, forbidden, notFound } from '../util.js';
import { notify } from '../notifications.js';
import { zoneOrUtc } from '../ics.js';
import { fromWallClock } from '../calmath.js';

q(`CREATE TABLE IF NOT EXISTS time_off (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, -- YYYY-MM-DD, both included
  tz TEXT NOT NULL,
  kind TEXT NOT NULL,                                -- vacation | sick | personal | other
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | approved | declined | cancelled
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER, answer TEXT,
  event_id TEXT,
  created_at INTEGER NOT NULL
)`).run();

export const KINDS = { vacation: 'Vacation', sick: 'Sick leave', personal: 'Personal', other: 'Time off' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Weekdays (Monday to Friday) from a to b, both included: how many working days a request takes. */
export function workdays(a, b) {
  let n = 0;
  for (let t = Date.parse(`${a}T00:00:00Z`), end = Date.parse(`${b}T00:00:00Z`); t <= end; t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** Who decides someone's time off: whoever they report to, else the company's admins (not themselves). */
export function approversOf(userId) {
  const u = q('SELECT id, org_id, manager_id FROM users WHERE id = ?').get(userId);
  if (!u) return [];
  const m = u.manager_id && q('SELECT id FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(u.manager_id, u.org_id);
  if (m) return [m.id];
  return q('SELECT id FROM users WHERE org_id = ? AND is_admin = 1 AND disabled = 0 AND id != ?').all(u.org_id, u.id).map((x) => x.id);
}

const mayDecide = (approver, r) => approversOf(r.user_id).includes(approver.id);
const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
export const span = (r) => (r.start_date === r.end_date ? fmt(r.start_date) : `${fmt(r.start_date)} – ${fmt(r.end_date)}`);

function out(r) {
  const who = q('SELECT name, username FROM users WHERE id = ?').get(r.user_id);
  const by = r.decided_by ? q('SELECT name FROM users WHERE id = ?').get(r.decided_by)?.name : null;
  return { id: r.id, user_id: r.user_id, name: who?.name, username: who?.username, start_date: r.start_date, end_date: r.end_date, kind: r.kind, kind_label: KINDS[r.kind],
    note: r.note, status: r.status, decided_by_name: by || null, decided_at: r.decided_at, answer: r.answer, days: workdays(r.start_date, r.end_date), created_at: r.created_at, event_id: r.event_id };
}

/** The all-day out-of-office event for approved time off (in the time zone it was asked in). */
function addEvent(r) {
  const [y0, m0, d0] = r.start_date.split('-').map(Number), [y1, m1, d1] = r.end_date.split('-').map(Number);
  const tz = zoneOrUtc(r.tz);
  const start = fromWallClock(y0, m0 - 1, d0, 0, 0, 0, 0, tz);
  const end = fromWallClock(y1, m1 - 1, d1 + 1, 0, 0, 0, 0, tz) - 1;
  const id = uid();
  q(`INSERT INTO events (id, owner_id, title, description, start, end, all_day, exdates, tz, kind) VALUES (?, ?, ?, ?, ?, ?, 1, '[]', ?, 'ooo')`)
    .run(id, r.user_id, KINDS[r.kind], r.note || null, start, end, tz);
  return id;
}

export default function timeOffRoutes() {
  const r = Router();

  // Your own requests, and the ones waiting for you to decide (with the last month's decided ones).
  r.get('/', (req, res) => {
    const mine = q('SELECT * FROM time_off WHERE user_id = ? ORDER BY start_date DESC LIMIT 100').all(req.user.id).map(out);
    const team = q(`SELECT t.* FROM time_off t JOIN users u ON u.id = t.user_id WHERE u.org_id = ? AND t.user_id != ? AND (t.status = 'pending' OR t.decided_at > ?)
                    ORDER BY t.status = 'pending' DESC, t.start_date`).all(req.user.org_id, req.user.id, Date.now() - 30 * 864e5)
      .filter((t) => mayDecide(req.user, t)).map(out);
    res.json({ mine, to_decide: team, approvers: approversOf(req.user.id).length });
  });

  r.post('/', (req, res) => {
    const { start_date: a, end_date: b = a, kind = 'vacation' } = req.body || {};
    if (!validDate(a) || !validDate(b)) throw bad('Choose the first and last day');
    if (b < a) throw bad('The last day is before the first');
    if (workdays(a, b) === 0 && a === b && [0, 6].includes(new Date(`${a}T00:00:00Z`).getUTCDay())) throw bad('That day is a weekend');
    if ((Date.parse(b) - Date.parse(a)) / 864e5 > 92) throw bad('At most three months at a time');
    if (!KINDS[kind]) throw bad('Unknown kind of time off');
    const overlap = q("SELECT 1 FROM time_off WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?").get(req.user.id, b, a);
    if (overlap) throw bad('You already asked for time off on some of these days');
    const note = String(req.body.note || '').trim().slice(0, 500) || null;
    const row = { id: uid(), user_id: req.user.id, start_date: a, end_date: b, tz: zoneOrUtc(req.body.tz), kind, note, status: 'pending', created_at: Date.now() };
    const approvers = approversOf(req.user.id);
    tx(() => {
      q('INSERT INTO time_off (id, user_id, start_date, end_date, tz, kind, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.user_id, a, b, row.tz, kind, note, 'pending', row.created_at);
      // Nobody to ask (a company of one): it's approved straight away.
      if (!approvers.length) {
        const ev = addEvent(row);
        q("UPDATE time_off SET status = 'approved', decided_at = ?, event_id = ? WHERE id = ?").run(Date.now(), ev, row.id);
      }
    });
    if (approvers.length) {
      notify(approvers, { kind: 'timeoff', title: `${req.user.name} asks for time off`, body: `${KINDS[kind]}: ${span(row)} (${workdays(a, b)} working day${workdays(a, b) === 1 ? '' : 's'})${note ? ` · ${note}` : ''}`, link: '/calendar?timeoff=1', actor: req.user.id });
    }
    res.status(201).json(out(q('SELECT * FROM time_off WHERE id = ?').get(row.id)));
  });

  // Approve or decline (whoever decides for that person), with an optional answer.
  r.post('/:id/decide', (req, res) => {
    const t = q('SELECT * FROM time_off WHERE id = ?').get(String(req.params.id));
    if (!t || q('SELECT org_id FROM users WHERE id = ?').get(t.user_id)?.org_id !== req.user.org_id) throw notFound('Request not found');
    if (!mayDecide(req.user, t)) throw forbidden('Only whoever they report to (or an admin, if nobody) can decide');
    if (t.status !== 'pending') throw bad(`This request was already ${t.status}`);
    const approve = !!req.body?.approve;
    const answer = String(req.body?.answer || '').trim().slice(0, 500) || null;
    tx(() => {
      const ev = approve ? addEvent(t) : null;
      q('UPDATE time_off SET status = ?, decided_by = ?, decided_at = ?, answer = ?, event_id = ? WHERE id = ?').run(approve ? 'approved' : 'declined', req.user.id, Date.now(), answer, ev, t.id);
    });
    notify([t.user_id], { kind: 'timeoff', title: `${req.user.name} ${approve ? 'approved' : 'declined'} your time off`, body: `${KINDS[t.kind]}: ${span(t)}${answer ? ` · ${answer}` : ''}`, link: '/calendar?timeoff=1', actor: req.user.id });
    res.json(out(q('SELECT * FROM time_off WHERE id = ?').get(t.id)));
  });

  // Take back your own request (approved time off too: its event goes, and whoever approved it is told).
  r.delete('/:id', (req, res) => {
    const t = q('SELECT * FROM time_off WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
    if (!t) throw notFound('Request not found');
    if (!['pending', 'approved'].includes(t.status)) throw bad(`This request was already ${t.status}`);
    tx(() => {
      if (t.event_id) q('DELETE FROM events WHERE id = ? AND owner_id = ?').run(t.event_id, t.user_id);
      q("UPDATE time_off SET status = 'cancelled', event_id = NULL WHERE id = ?").run(t.id);
    });
    const tell = t.status === 'approved' && t.decided_by ? [t.decided_by] : t.status === 'pending' ? approversOf(t.user_id) : [];
    notify(tell, { kind: 'timeoff', title: `${req.user.name} cancelled time off`, body: `${KINDS[t.kind]}: ${span(t)}`, link: '/calendar?timeoff=1', actor: req.user.id });
    res.json(out(q('SELECT * FROM time_off WHERE id = ?').get(t.id)));
  });
  return r;
}
