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

// Vacation allowance: days a year for the company (Time off → Team), or for one person; none: no limit.
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'vacation_days')) q('ALTER TABLE orgs ADD COLUMN vacation_days INTEGER').run();
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'vacation_days')) q('ALTER TABLE users ADD COLUMN vacation_days INTEGER').run();

// Company holidays (Time off → Team): days off for everyone, shown on everyone's calendar and not
// counted as working days in time off.
q(`CREATE TABLE IF NOT EXISTS company_holidays (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  date TEXT NOT NULL, name TEXT NOT NULL,
  UNIQUE (org_id, date)
)`).run();
/** The company's holidays as a Set of YYYY-MM-DD. */
export const holidaySet = (orgId) => new Set(q('SELECT date FROM company_holidays WHERE org_id = ?').all(orgId).map((h) => h.date));
const orgOf = (userId) => q('SELECT org_id FROM users WHERE id = ?').get(userId)?.org_id;

export const KINDS = { vacation: 'Vacation', sick: 'Sick leave', personal: 'Personal', other: 'Time off' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Weekdays (Monday to Friday) from a to b, both included, but not holidays: how many working days a request takes. */
export function workdays(a, b, holidays = new Set()) {
  let n = 0;
  for (let t = Date.parse(`${a}T00:00:00Z`), end = Date.parse(`${b}T00:00:00Z`); t <= end; t += 864e5) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(new Date(t).toISOString().slice(0, 10))) n++;
  }
  return n;
}

/** The working days of a..b that fall in `year`. */
export function workdaysIn(a, b, year, holidays = new Set()) {
  const from = a > `${year}-01-01` ? a : `${year}-01-01`, to = b < `${year}-12-31` ? b : `${year}-12-31`;
  return from > to ? 0 : workdays(from, to, holidays);
}
/** Someone's vacation days a year (their own, else the company's), or null for no limit. */
export function allowanceOf(userId) {
  const u = q('SELECT u.vacation_days AS own, o.vacation_days AS org FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ?').get(userId);
  return u?.own ?? u?.org ?? null;
}
/** Their vacation in a year: { year, days (allowance or null), used (approved), pending, left }. */
export function balanceOf(userId, year) {
  const rows = q("SELECT start_date, end_date, status FROM time_off WHERE user_id = ? AND kind = 'vacation' AND status IN ('approved', 'pending') AND start_date <= ? AND end_date >= ?")
    .all(userId, `${year}-12-31`, `${year}-01-01`);
  const hol = holidaySet(orgOf(userId));
  const sum = (st) => rows.filter((x) => x.status === st).reduce((n, x) => n + workdaysIn(x.start_date, x.end_date, year, hol), 0);
  const days = allowanceOf(userId), used = sum('approved'), pending = sum('pending');
  return { year, days, used, pending, left: days === null ? null : days - used - pending };
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
    note: r.note, status: r.status, decided_by_name: by || null, decided_at: r.decided_at, answer: r.answer, days: workdays(r.start_date, r.end_date, holidaySet(orgOf(r.user_id))), created_at: r.created_at, event_id: r.event_id };
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
    const year = new Date().getUTCFullYear();
    for (const t of team) t.balance = balanceOf(t.user_id, Number(t.start_date.slice(0, 4)));
    res.json({ mine, to_decide: team, approvers: approversOf(req.user.id).length, balance: balanceOf(req.user.id, year) });
  });

  // The team: the people whose time off you decide (everyone, for an admin), with their vacation this
  // year and what's coming up in the next three months.
  r.get('/team', (req, res) => {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const people = q('SELECT id, name, username, vacation_days FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name').all(req.user.org_id)
      .filter((u) => req.user.is_admin || approversOf(u.id).includes(req.user.id)); // admins see everyone, themselves included
    if (!people.length && !req.user.is_admin) throw forbidden('Nobody reports to you');
    const today = new Date().toISOString().slice(0, 10), until = new Date(Date.now() + 92 * 864e5).toISOString().slice(0, 10);
    const org = q('SELECT vacation_days FROM orgs WHERE id = ?').get(req.user.org_id);
    res.json({
      year, company_days: org?.vacation_days ?? null, can_set: !!req.user.is_admin,
      people: people.map((u) => ({ id: u.id, name: u.name, username: u.username, own_days: u.vacation_days, balance: balanceOf(u.id, year),
        coming: q("SELECT * FROM time_off WHERE user_id = ? AND status IN ('approved', 'pending') AND end_date >= ? AND start_date <= ? ORDER BY start_date").all(u.id, today, until).map(out) })),
    });
  });

  // Company holidays: everyone sees them (for the calendar); admins add and remove them.
  r.get('/holidays', (req, res) => {
    const from = DATE.test(req.query.from || '') ? req.query.from : '0000-01-01', to = DATE.test(req.query.to || '') ? req.query.to : '9999-12-31';
    res.json(q('SELECT id, date, name FROM company_holidays WHERE org_id = ? AND date >= ? AND date <= ? ORDER BY date').all(req.user.org_id, from, to));
  });
  r.post('/holidays', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins set company holidays');
    const date = String(req.body?.date || ''), name = String(req.body?.name || '').trim().slice(0, 100);
    if (!validDate(date)) throw bad('Choose a day');
    if (!name) throw bad('Give the holiday a name');
    if (q('SELECT 1 FROM company_holidays WHERE org_id = ? AND date = ?').get(req.user.org_id, date)) throw bad('There is already a holiday that day');
    if (q('SELECT COUNT(*) AS n FROM company_holidays WHERE org_id = ?').get(req.user.org_id).n >= 500) throw bad('Too many holidays; remove past ones first');
    const id = uid();
    q('INSERT INTO company_holidays (id, org_id, date, name) VALUES (?, ?, ?, ?)').run(id, req.user.org_id, date, name);
    res.status(201).json({ id, date, name });
  });
  r.delete('/holidays/:id', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins set company holidays');
    if (!q('DELETE FROM company_holidays WHERE id = ? AND org_id = ?').run(String(req.params.id), req.user.org_id).changes) throw notFound('Holiday not found');
    res.json({ ok: true });
  });

  // Vacation allowance (admins): the company's days a year, or one person's (null: the company's).
  const days = (v) => {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 366) throw bad('Days a year: a whole number from 0 to 366');
    return n;
  };
  r.put('/allowance', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins set vacation allowances');
    q('UPDATE orgs SET vacation_days = ? WHERE id = ?').run(days(req.body?.days), req.user.org_id);
    res.json({ days: q('SELECT vacation_days FROM orgs WHERE id = ?').get(req.user.org_id).vacation_days });
  });
  r.put('/allowance/:userId', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins set vacation allowances');
    const u = q('SELECT id FROM users WHERE id = ? AND org_id = ?').get(String(req.params.userId), req.user.org_id);
    if (!u) throw notFound('User not found');
    q('UPDATE users SET vacation_days = ? WHERE id = ?').run(days(req.body?.days), u.id);
    res.json({ days: allowanceOf(u.id), own_days: q('SELECT vacation_days FROM users WHERE id = ?').get(u.id).vacation_days });
  });

  r.post('/', (req, res) => {
    const { start_date: a, end_date: b = a, kind = 'vacation' } = req.body || {};
    if (!validDate(a) || !validDate(b)) throw bad('Choose the first and last day');
    if (b < a) throw bad('The last day is before the first');
    const hol = holidaySet(req.user.org_id);
    if (workdays(a, b, hol) === 0) throw bad(a === b ? 'That day isn’t a working day (a weekend or a company holiday)' : 'Those days aren’t working days (weekends or company holidays)');
    if ((Date.parse(b) - Date.parse(a)) / 864e5 > 92) throw bad('At most three months at a time');
    if (!KINDS[kind]) throw bad('Unknown kind of time off');
    const overlap = q("SELECT 1 FROM time_off WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?").get(req.user.id, b, a);
    if (overlap) throw bad('You already asked for time off on some of these days');
    // Vacation: within what's left of each year's allowance (approved and waiting both count).
    if (kind === 'vacation') {
      for (let y = Number(a.slice(0, 4)); y <= Number(b.slice(0, 4)); y++) {
        const bal = balanceOf(req.user.id, y), want = workdaysIn(a, b, y, hol);
        if (bal.left !== null && want > bal.left) throw bad(`That's ${want} vacation day${want === 1 ? '' : 's'} in ${y}; you have ${Math.max(0, bal.left)} left`);
      }
    }
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
      notify(approvers, { kind: 'timeoff', title: `${req.user.name} asks for time off`, body: `${KINDS[kind]}: ${span(row)} (${workdays(a, b, hol)} working day${workdays(a, b, hol) === 1 ? '' : 's'})${note ? ` · ${note}` : ''}`, link: '/calendar?timeoff=1', actor: req.user.id });
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
