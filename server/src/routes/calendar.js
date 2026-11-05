import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, str, int, bad, notFound } from '../util.js';
import { canReach } from '../tenancy.js';
import { sendTo } from '../hub.js';
import { mailEnabled } from '../mail/config.js';
import { smtpFor } from '../mail/imap.js';

q(`CREATE TABLE IF NOT EXISTS event_guests (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'needs',   -- needs | yes | maybe | no
  PRIMARY KEY (event_id, user_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS event_guests_user ON event_guests(user_id)').run();
const ANSWERS = ['yes', 'maybe', 'no'];
const MAX_GUESTS = 50;

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

const guestsOf = (eventId) => q(`SELECT u.id, u.username AS email, u.name, g.status FROM event_guests g JOIN users u ON u.id = g.user_id
                                  WHERE g.event_id = ? ORDER BY u.name`).all(eventId);

/** Guests from a list of addresses: people the organizer can reach (not themselves). */
function readGuests(user, list) {
  if (!Array.isArray(list)) throw bad('Guests must be a list of email addresses');
  const emails = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  if (emails.length > MAX_GUESTS) throw bad(`At most ${MAX_GUESTS} guests`);
  return emails.filter((e) => e !== user.username).map((email) => {
    const u = q('SELECT id, username, name FROM users WHERE username = ? AND disabled = 0').get(email);
    if (!u || !canReach(user, u.id)) throw bad(`${email} can't be invited: there's no one with that address you can work with`);
    return u;
  });
}

/** Set the guest list, keeping the answers of people who stay invited. Returns who was added and removed. */
function setGuests(eventId, guests) {
  const before = new Map(q('SELECT user_id, status FROM event_guests WHERE event_id = ?').all(eventId).map((g) => [g.user_id, g.status]));
  const want = new Set(guests.map((g) => g.id));
  tx(() => {
    q('DELETE FROM event_guests WHERE event_id = ?').run(eventId);
    for (const g of guests) q('INSERT INTO event_guests (event_id, user_id, status) VALUES (?, ?, ?)').run(eventId, g.id, before.get(g.id) || 'needs');
  });
  return { added: guests.filter((g) => !before.has(g.id)), removed: [...before.keys()].filter((id) => !want.has(id)) };
}

/** When an event happens, written in the organizer's time zone (the browser tells us which). */
function whenText(e, tz) {
  const zone = (() => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz }).resolvedOptions().timeZone; } catch { return 'UTC'; } })();
  const fmt = (ms, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...opts }).format(new Date(ms));
  const day = (ms) => fmt(ms, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
  const repeats = e.rrule ? ` (repeats ${e.rrule.freq}${e.rrule.interval > 1 ? `, every ${e.rrule.interval}` : ''})` : '';
  if (e.all_day) return `${day(e.start)}, all day${repeats}`;
  return `${day(e.start)}, ${time(e.start)} – ${time(e.end)} (${zone})${repeats}`;
}

/** Email the guests (best effort: a failed email never fails the change). */
function notify(organizer, e, recipients, kind, tz) {
  if (!mailEnabled() || !recipients.length) return;
  const subject = `${kind === 'cancel' ? 'Cancelled' : 'Invitation'}: ${e.title}`;
  const lines = kind === 'cancel'
    ? [`${organizer.name} cancelled this event:`, '', e.title, whenText(e, tz)]
    : [`${organizer.name} invited you to:`, '', e.title, whenText(e, tz), ...(e.location ? [`Where: ${e.location}`] : []), ...(e.description ? ['', e.description] : []),
      '', 'Open Calendar in Workspace to answer Yes, Maybe or No.'];
  smtpFor(organizer).sendMail({
    from: { name: organizer.name, address: organizer.username },
    to: recipients.map((g) => ({ name: g.name, address: g.username || g.email })),
    subject, text: lines.join('\n'),
  }).catch((err) => console.error('[calendar] invitation email failed:', err.message));
}

/** Tell everyone involved to refresh (organizer's other tabs, and guests). */
const touch = (ids) => sendTo([...new Set(ids)], { type: 'events-changed' });

export default function calendarRoutes() {
  const r = Router();

  // Events overlapping [from, to)
  r.get('/', (req, res) => {
    const from = int(req.query.from ?? 0, 'from');
    const to = int(req.query.to ?? 8.64e15, 'to');
    // Repeating events count from their first date; the browser expands them in local time.
    // Your own events and the ones you're invited to.
    const rows = q(`SELECT e.*, g.status AS my_status, o.name AS organizer_name, o.username AS organizer_email
                    FROM events e JOIN users o ON o.id = e.owner_id
                    LEFT JOIN event_guests g ON g.event_id = e.id AND g.user_id = ?
                    WHERE (e.owner_id = ? OR g.user_id IS NOT NULL) AND e.start < ?
                    AND (e.end >= ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until >= ?))) ORDER BY e.start`)
      .all(req.user.id, req.user.id, to, from, from);
    res.json(rows.map((row) => {
      const mine = row.owner_id === req.user.id;
      const { my_status, organizer_name, organizer_email, ...ev } = row;
      return { ...outEvent(ev), role: mine ? 'organizer' : 'guest', guests: guestsOf(row.id).map(({ id, ...g }) => g),
        ...(mine ? {} : { my_status, organizer: { name: organizer_name, email: organizer_email } }) };
    }));
  });

  r.post('/', (req, res) => {
    const e = readEvent(req.body);
    // Check the guests before saving anything, so a refused invitation leaves no event behind.
    const guests = req.body.guests !== undefined ? readGuests(req.user, req.body.guests) : null;
    const id = uid();
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, e.title, e.description ?? null, e.location ?? null, e.start, e.end, e.all_day ?? 0, e.color ?? null,
        e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e));
    if (guests) {
      const { added } = setGuests(id, guests);
      notify(req.user, e, added, 'invite', req.body.tz);
      touch(added.map((g) => g.id));
    }
    res.status(201).json({ ...outEvent(q('SELECT * FROM events WHERE id = ?').get(id)), role: 'organizer', guests: guestsOf(id).map(({ id: _, ...g }) => g) });
  });

  r.patch('/:id', (req, res) => {
    const existing = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!existing) throw notFound();
    const e = readEvent(req.body, outEvent(existing));
    const guests = req.body.guests !== undefined ? readGuests(req.user, req.body.guests) : null; // before changing anything
    q(`UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, color = ?, rrule = ?, exdates = ?, repeat_until = ? WHERE id = ?`)
      .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.color, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), e.id);
    let removed = [];
    if (guests) {
      const change = setGuests(e.id, guests);
      removed = change.removed;
      notify(req.user, e, change.added, 'invite', req.body.tz);
      notify(req.user, e, removed.map((id) => q('SELECT username, name FROM users WHERE id = ?').get(id)).filter(Boolean), 'cancel', req.body.tz);
    }
    touch([req.user.id, ...guestsOf(e.id).map((g) => g.id), ...removed]);
    res.json({ ...outEvent(q('SELECT * FROM events WHERE id = ?').get(e.id)), role: 'organizer', guests: guestsOf(e.id).map(({ id, ...g }) => g) });
  });

  r.delete('/:id', (req, res) => {
    const ev = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!ev) throw notFound();
    const guests = guestsOf(ev.id);
    q('DELETE FROM events WHERE id = ?').run(ev.id);
    notify(req.user, outEvent(ev), guests.map((g) => ({ username: g.email, name: g.name })), 'cancel', req.query.tz);
    touch([req.user.id, ...guests.map((g) => g.id)]);
    res.json({ ok: true });
  });

  // A guest's answer: yes, maybe or no.
  r.post('/:id/rsvp', (req, res) => {
    const status = String(req.body.status || '');
    if (!ANSWERS.includes(status)) throw bad('Answer yes, maybe or no');
    const ev = q('SELECT owner_id FROM events WHERE id = ?').get(req.params.id);
    const info = q('UPDATE event_guests SET status = ? WHERE event_id = ? AND user_id = ?').run(status, req.params.id, req.user.id);
    if (!ev || !info.changes) throw notFound();
    touch([ev.owner_id, req.user.id]);
    res.json({ ok: true, status });
  });

  return r;
}
