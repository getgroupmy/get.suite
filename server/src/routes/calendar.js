import { notify as bell } from '../notifications.js';
import { Router } from 'express';
import { expand } from '../calmath.js';
import { q, tx } from '../db.js';
import { uid, str, int, bad, notFound, HttpError } from '../util.js';
import { canReach } from '../tenancy.js';
import { sendTo } from '../hub.js';
import crypto from 'node:crypto';
import { mailEnabled, MAIL_HOSTNAME } from '../mail/config.js';
import { smtpFor } from '../mail/imap.js';
import { buildIcs, zoneOrUtc } from '../ics.js';
import { remindersFor, remindersOf, setReminders } from '../reminders.js';
import { setRooms, roomsOf } from './rooms.js';
import express from 'express';
import { importCalendar, exportCalendar } from '../calimport.js';
import { roleFor, audienceFor } from '../access.js';
import { recordActivity } from '../fileactivity.js';

q(`CREATE TABLE IF NOT EXISTS event_guests (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'needs',   -- needs | yes | maybe | no
  PRIMARY KEY (event_id, user_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS event_guests_user ON event_guests(user_id)').run();
// Guests outside the server: invited by email with a calendar file, answering on a web page.
q(`CREATE TABLE IF NOT EXISTS event_outside_guests (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'needs',   -- needs | yes | maybe | no
  token TEXT NOT NULL UNIQUE,             -- the secret in their answer link
  answered_at INTEGER,
  PRIMARY KEY (event_id, email)
)`).run();
const hasColumn = (t, c) => q(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
if (!hasColumn('events', 'sequence')) q('ALTER TABLE events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0').run(); // bumped when details change
if (!hasColumn('events', 'tz')) q('ALTER TABLE events ADD COLUMN tz TEXT').run(); // the organizer's time zone, for calendar files
// Files from Drive attached to an event: [{ id, name, kind, mime }]. Guests are given view access to the
// ones the organizer owns; each person sees whether they can open each one.
if (!hasColumn('events', 'attachments')) q('ALTER TABLE events ADD COLUMN attachments TEXT').run();
if (!hasColumn('events', 'kind')) q('ALTER TABLE events ADD COLUMN kind TEXT').run(); // null, or 'ooo': out of office (invitations then are declined)
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
  if (body.kind !== undefined) {
    if (body.kind && body.kind !== 'ooo') throw bad('Unknown kind of event');
    e.kind = body.kind || null;
  }
  if (body.exdates !== undefined) e.exdates = readExdates(body.exdates);
  if (e.end < e.start) throw bad('End must be after start');
  if (e.rrule?.until !== undefined && e.rrule.until < e.start) throw bad('The repeat ends before the event starts');
  return e;
}

export const outEvent = (row) => ({ ...row, rrule: row.rrule ? JSON.parse(row.rrule) : null, exdates: JSON.parse(row.exdates || '[]'), repeat_until: undefined,
  attachments: row.attachments ? JSON.parse(row.attachments) : [] });
const MAX_ATTACHMENTS = 20;
/** Attachments as asked ([file ids]): ones you can open, or ones already on the event (kept even if you can't any more). */
function readAttachments(user, ids, existing = []) {
  if (!Array.isArray(ids)) throw bad('attachments must be a list of files');
  const unique = [...new Set(ids.map(String))];
  if (unique.length > MAX_ATTACHMENTS) throw bad(`At most ${MAX_ATTACHMENTS} attachments`);
  return unique.map((id) => {
    const kept = existing.find((a) => a.id === id);
    const f = q('SELECT id, name, kind, mime FROM files WHERE id = ? AND trashed = 0').get(id);
    if (!f || f.kind === 'folder' || (!kept && !roleFor(f.id, user.id))) throw bad('A file is not available to attach');
    return { id: f.id, name: f.name, kind: f.kind, mime: f.mime || null };
  });
}
/** Guests (on the server) can view the attachments the organizer owns; nobody loses access they had. */
function shareAttachments(owner, eventId) {
  const ev = q('SELECT attachments FROM events WHERE id = ?').get(eventId);
  const files = ev?.attachments ? JSON.parse(ev.attachments) : [];
  const guests = q('SELECT user_id FROM event_guests WHERE event_id = ?').all(eventId).map((g) => g.user_id);
  for (const a of files) {
    if (roleFor(a.id, owner.id) !== 'owner') continue;
    const given = [];
    for (const g of guests) {
      if (!canReach(owner, g) || roleFor(a.id, g)) continue;
      q('INSERT INTO shares (file_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(file_id, user_id) DO NOTHING').run(a.id, g, 'viewer');
      given.push(q('SELECT name FROM users WHERE id = ?').get(g)?.name || 'someone');
    }
    if (given.length) {
      recordActivity(a.id, owner.id, 'share', { added: given.map((n) => `${n} (can view, guest of an event)`), removed: [] });
      const parent = q('SELECT parent_id FROM files WHERE id = ?').get(a.id)?.parent_id;
      sendTo(new Set(audienceFor(a.id)), { type: 'files-changed', parent_id: parent });
    }
  }
}
/** Each attachment with whether this person can open it. */
const attachmentsFor = (ev, userId) => (ev.attachments || []).map((a) => ({ ...a, can_open: !!roleFor(a.id, userId) }));
// When a series ends, for the range query: its last possible end (null = never, or "after N times").
const repeatUntil = (e) => (e.rrule ? (e.rrule.until !== undefined ? e.rrule.until + (e.end - e.start) : null) : null);

const guestsOf = (eventId) => q(`SELECT u.id, u.username AS email, u.name, g.status FROM event_guests g JOIN users u ON u.id = g.user_id
                                  WHERE g.event_id = ? ORDER BY u.name`).all(eventId);

const EMAIL_RE = /^[^\s@<>"(),;:\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ourDomain = (email) => !!q('SELECT 1 FROM domains WHERE name = ?').get(email.split('@')[1]);

/**
 * Guests from a list of addresses (not the organizer): people on this server the organizer can
 * work with, and, when email is on, anyone else by email address. An address on one of this
 * server's own domains must belong to someone (a typo there shouldn't email a stranger).
 */
function readGuests(user, list) {
  if (!Array.isArray(list)) throw bad('Guests must be a list of email addresses');
  const emails = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].filter((e) => e !== user.username);
  if (emails.length > MAX_GUESTS) throw bad(`At most ${MAX_GUESTS} guests`);
  const inside = [], outside = [];
  for (const email of emails) {
    const u = q('SELECT id, username, name FROM users WHERE username = ? AND disabled = 0').get(email);
    if (u && canReach(user, u.id)) { inside.push(u); continue; }
    if (u || ourDomain(email) || !EMAIL_RE.test(email) || email.length > 254) {
      throw bad(`${email} can't be invited: there's no one with that address you can work with`);
    }
    if (!mailEnabled()) throw bad(`${email} can't be invited: email is turned off on this server, so people outside it can't get invitations`);
    outside.push(email);
  }
  return { inside, outside };
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

const outsideOf = (eventId) => q('SELECT email, status, token FROM event_outside_guests WHERE event_id = ? ORDER BY email').all(eventId);
/** The guest list shown in the calendar: colleagues, then people outside (marked external). */
const allGuests = (eventId) => [...guestsOf(eventId).map(({ id, ...g }) => g), ...outsideOf(eventId).map(({ token, ...g }) => ({ ...g, name: null, external: true }))];

/** Set the outside guests, keeping answers and links. Returns the added, kept and removed rows. */
export function setOutside(eventId, emails) {
  const before = new Map(outsideOf(eventId).map((g) => [g.email, g]));
  const want = new Set(emails);
  tx(() => {
    for (const [email] of before) if (!want.has(email)) q('DELETE FROM event_outside_guests WHERE event_id = ? AND email = ?').run(eventId, email);
    for (const email of emails) if (!before.has(email)) q('INSERT INTO event_outside_guests (event_id, email, token) VALUES (?, ?, ?)').run(eventId, email, crypto.randomBytes(18).toString('base64url'));
  });
  const after = outsideOf(eventId);
  return { added: after.filter((g) => !before.has(g.email)), kept: after.filter((g) => before.has(g.email)), removed: [...before.values()].filter((g) => !want.has(g.email)) };
}

/** Did anything a guest's calendar shows change? */
const DETAILS = ['title', 'description', 'location', 'start', 'end', 'all_day'];
const detailsChanged = (a, b) => DETAILS.some((k) => (a[k] ?? null) !== (b[k] ?? null))
  || JSON.stringify(a.rrule ?? null) !== JSON.stringify(b.rrule ?? null) || JSON.stringify(a.exdates || []) !== JSON.stringify(b.exdates || []);

const icsUid = (e) => `${e.id}@${MAIL_HOSTNAME || 'workspace'}`;
export const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/**
 * Email people outside the server: an invitation, an update or a cancellation, each with the
 * calendar file their mail app understands and a personal link to answer (best effort).
 */
export function notifyOutside(organizer, e, recipients, kind, { base, tz }) {
  if (!mailEnabled() || !recipients.length) return;
  const zone = zoneOrUtc(tz || e.tz);
  const everyone = [...guestsOf(e.id).map((g) => ({ email: g.email, name: g.name, status: g.status })), ...outsideOf(e.id).map((g) => ({ email: g.email, status: g.status }))];
  for (const g of recipients) {
    const method = kind === 'cancel' ? 'CANCEL' : 'REQUEST';
    const ics = buildIcs(e, { method, uid: icsUid(e), sequence: e.sequence || 0, tz: zone, organizer: { name: organizer.name, email: organizer.username },
      attendees: kind === 'cancel' ? [{ email: g.email, status: g.status }] : everyone });
    const subject = `${{ invite: 'Invitation', update: 'Updated invitation', cancel: 'Cancelled' }[kind]}: ${e.title}`;
    const link = `${base}/i/${g.token}`;
    const lines = kind === 'cancel'
      ? [`${organizer.name} cancelled this event:`, '', e.title, whenText(e, zone)]
      : [`${organizer.name} ${kind === 'update' ? 'changed this event' : 'invited you to'}:`, '', e.title, whenText(e, zone),
        ...(e.location ? [`Where: ${e.location}`] : []), ...(e.description ? ['', e.description] : []),
        '', `Answer Yes, Maybe or No: ${link}`, '', 'The attached invitation can be added to Outlook, Gmail or your phone\'s calendar.'];
    smtpFor(organizer).sendMail({
      from: { name: organizer.name, address: organizer.username },
      to: g.email,
      subject, text: lines.join('\n'),
      icalEvent: { method, filename: kind === 'cancel' ? 'cancel.ics' : 'invite.ics', content: ics },
    }).catch((err) => console.error('[calendar] outside invitation failed:', err.message));
  }
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
  if (recipients.length && kind !== 'update') bell(recipients.map((g) => g.id).filter(Boolean), { kind: 'invite', title: kind === 'cancel' ? `${organizer.name} cancelled “${e.title}”` : `${organizer.name} invited you to “${e.title}”`, body: whenText(e, tz), link: '/calendar', actor: organizer.name });
  if (!mailEnabled() || !recipients.length) return;
  const subject = `${{ cancel: 'Cancelled', update: 'Updated' }[kind] || 'Invitation'}: ${e.title}`;
  const lines = kind === 'cancel'
    ? [`${organizer.name} cancelled this event:`, '', e.title, whenText(e, tz)]
    : [`${organizer.name} ${kind === 'update' ? 'changed this event' : 'invited you to'}:`, '', e.title, whenText(e, tz), ...(e.location ? [`Where: ${e.location}`] : []), ...(e.description ? ['', e.description] : []),
      '', kind === 'update' ? 'Your Workspace calendar already shows the change.' : 'Open Calendar in Workspace to answer Yes, Maybe or No.'];
  smtpFor(organizer).sendMail({
    from: { name: organizer.name, address: organizer.username },
    to: recipients.map((g) => ({ name: g.name, address: g.username || g.email })),
    subject, text: lines.join('\n'),
  }).catch((err) => console.error('[calendar] invitation email failed:', err.message));
}

/**
 * The out-of-office event of this person's that overlaps an event's first time, if any (their own
 * repeating ones included). Used to decline invitations for them while they're away.
 */
export function awayDuring(userId, ev) {
  const rows = q(`SELECT * FROM events WHERE owner_id = ? AND kind = 'ooo' AND start < ?
                  AND (end > ? OR (rrule IS NOT NULL AND (repeat_until IS NULL OR repeat_until > ?)))`).all(userId, ev.end, ev.start, ev.start);
  return rows.find((r) => expand(outEvent(r), ev.start, ev.end).some((o) => o.start < ev.end && o.end > ev.start)) || null;
}

/** New guests who are out of office then answer No at once; the organizer is told (with their message). */
function declineAway(organizer, ev, added) {
  if (ev.kind === 'ooo') return;
  for (const g of added) {
    const away = awayDuring(g.id, ev);
    if (!away) continue;
    q("UPDATE event_guests SET status = 'no' WHERE event_id = ? AND user_id = ?").run(ev.id, g.id);
    bell([organizer.id], { kind: 'invite', title: `${g.name} is out of office and declined “${ev.title}”`, body: away.description || away.title, link: '/calendar', actor: g.name });
  }
}

/** Tell everyone involved to refresh (organizer's other tabs, and guests). */
export const touch = (ids) => sendTo([...new Set(ids)], { type: 'events-changed' });

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
    const reminders = remindersFor(req.user.id, rows.map((row) => row.id));
    res.json(rows.map((row) => {
      const mine = row.owner_id === req.user.id;
      const { my_status, organizer_name, organizer_email, ...ev } = row;
      const out = outEvent(ev);
      return { ...out, attachments: attachmentsFor(out, req.user.id), role: mine ? 'organizer' : 'guest', guests: allGuests(row.id), rooms: roomsOf(row.id), reminders: reminders.get(row.id) || [],
        ...(mine ? {} : { my_status, organizer: { name: organizer_name, email: organizer_email } }) };
    }));
  });

  // Search your events (and invitations) by words in the title, place or notes. Each result is
  // dated by its next time (repeating events) or its own; coming ones first, then past ones, newest first.
  r.get('/search', (req, res) => {
    const words = String(req.query.q || '').toLowerCase().match(/[\p{L}\p{N}@._'-]+/gu)?.slice(0, 8) || [];
    if (!words.length) return res.json([]);
    const like = words.map(() => "LOWER(COALESCE(e.title, '') || ' ' || COALESCE(e.location, '') || ' ' || COALESCE(e.description, '')) LIKE ? ESCAPE '!'");
    const rows = q(`SELECT e.*, g.status AS my_status FROM events e LEFT JOIN event_guests g ON g.event_id = e.id AND g.user_id = ?
                    WHERE (e.owner_id = ? OR g.user_id IS NOT NULL) AND ${like.join(' AND ')} ORDER BY e.start DESC LIMIT 500`)
      .all(req.user.id, req.user.id, ...words.map((w) => `%${w.replace(/[%_!]/g, (x) => `!${x}`)}%`));
    const now = Date.now();
    const found = rows.map((row) => {
      const ev = outEvent(row);
      let at = { start: ev.start, end: ev.end };
      if (ev.rrule) {
        const next = expand(ev, now, now + 3 * 366 * 864e5)[0];
        const last = next ? null : expand(ev, ev.start, now).pop();
        at = next || last || at;
      }
      return { id: ev.id, title: ev.title, location: ev.location, all_day: ev.all_day, color: ev.color, repeats: !!ev.rrule,
        role: ev.owner_id === req.user.id ? 'organizer' : 'guest', my_status: row.my_status || undefined, start: at.start, end: at.end, upcoming: at.end >= now };
    });
    const coming = found.filter((e) => e.upcoming).sort((a, b) => a.start - b.start);
    const past = found.filter((e) => !e.upcoming).sort((a, b) => b.start - a.start);
    res.json([...coming, ...past].slice(0, 50));
  });

  // A calendar file (.ics) from another calendar app: its events are added to yours.
  r.post('/import', express.text({ type: () => true, limit: '20mb' }), (req, res) => {
    const r2 = importCalendar(req.user.id, req.body, String(req.query.tz || 'UTC'));
    if (r2.error) throw bad(r2.error);
    if (r2.added) touch([req.user.id]);
    res.json(r2);
  });
  // Your own events as one calendar file.
  r.get('/export', (req, res) => {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
    res.send(exportCalendar(req.user.id));
  });

  r.post('/', (req, res) => {
    const e = readEvent(req.body);
    // Check the guests before saving anything, so a refused invitation leaves no event behind.
    const guests = req.body.guests !== undefined && e.kind !== 'ooo' ? readGuests(req.user, req.body.guests) : null;
    const attachments = req.body.attachments !== undefined ? readAttachments(req.user, req.body.attachments) : [];
    const id = uid();
    const tz = req.body.tz ? zoneOrUtc(req.body.tz) : null;
    // "This event" of a repeating one: remember which series and occurrence it replaces (phones show it as part of the series).
    const of = req.body.recurrence_of;
    const parent = of && !e.rrule ? q('SELECT id FROM events WHERE id = ? AND owner_id = ? AND rrule IS NOT NULL').get(String(of.id || ''), req.user.id) : null;
    q(`INSERT INTO events (id, owner_id, title, description, location, start, end, all_day, color, rrule, exdates, repeat_until, tz, recur_parent, recur_id, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, e.title, e.description ?? null, e.location ?? null, e.start, e.end, e.all_day ?? 0, e.color ?? null,
        e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), tz, parent?.id ?? null, parent ? int(of.occurrence, 'occurrence') : null, e.kind ?? null);
    const reminders = setReminders(id, req.user.id, req.body.reminders);
    if (attachments.length) q('UPDATE events SET attachments = ? WHERE id = ?').run(JSON.stringify(attachments), id);
    if (guests) {
      const { added } = setGuests(id, guests.inside);
      const outside = setOutside(id, guests.outside);
      const saved = outEvent(q('SELECT * FROM events WHERE id = ?').get(id));
      shareAttachments(req.user, id); // before they're told, so the files open from the invitation
      notify(req.user, saved, added, 'invite', req.body.tz);
      declineAway(req.user, saved, added);
      notifyOutside(req.user, saved, outside.added, 'invite', { base: baseUrl(req), tz });
      touch(added.map((g) => g.id));
    }
    if (req.body.rooms !== undefined && e.kind !== 'ooo') setRooms(req.user, q('SELECT * FROM events WHERE id = ?').get(id), req.body.rooms);
    touch([req.user.id]); // your other tabs (and their reminders) see it too
    const made = outEvent(q('SELECT * FROM events WHERE id = ?').get(id));
    res.status(201).json({ ...made, attachments: attachmentsFor(made, req.user.id), role: 'organizer', guests: allGuests(id), rooms: roomsOf(id), reminders });
  });

  r.patch('/:id', (req, res) => {
    const existing = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!existing) throw notFound();
    const before = outEvent(existing);
    const e = readEvent(req.body, before);
    const guests = req.body.guests !== undefined ? readGuests(req.user, e.kind === 'ooo' ? [] : req.body.guests) : null; // before changing anything
    const attachments = req.body.attachments !== undefined ? readAttachments(req.user, req.body.attachments, before.attachments) : null;
    const tz = req.body.tz ? zoneOrUtc(req.body.tz) : existing.tz;
    const changed = detailsChanged(before, e);
    q(`UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, color = ?, rrule = ?, exdates = ?, repeat_until = ?,
       tz = ?, sequence = sequence + ?, kind = ? WHERE id = ?`)
      .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.color, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e),
        tz, changed ? 1 : 0, e.kind ?? null, e.id);
    if (attachments) q('UPDATE events SET attachments = ? WHERE id = ?').run(attachments.length ? JSON.stringify(attachments) : null, e.id);
    const saved = outEvent(q('SELECT * FROM events WHERE id = ?').get(e.id));
    if (req.body.reminders !== undefined) setReminders(e.id, req.user.id, req.body.reminders);
    let removed = [];
    let added = [];
    let outside = { added: [], kept: outsideOf(e.id), removed: [] };
    if (guests) {
      const change = setGuests(e.id, guests.inside);
      removed = change.removed;
      added = change.added;
      outside = setOutside(e.id, guests.outside);
      shareAttachments(req.user, e.id);
      notify(req.user, saved, change.added, 'invite', req.body.tz);
      declineAway(req.user, saved, change.added);
      notify(req.user, saved, removed.map((id) => q('SELECT username, name FROM users WHERE id = ?').get(id)).filter(Boolean), 'cancel', req.body.tz);
    }
    // People outside only see what we email them: new guests are invited, the others get the update.
    const opts = { base: baseUrl(req), tz };
    notifyOutside(req.user, saved, outside.added, 'invite', opts);
    if (changed) notifyOutside(req.user, saved, outside.kept, 'update', opts);
    // Colleagues see the change in their calendar at once; an email tells them it happened.
    if (changed) notify(req.user, saved, guestsOf(e.id).filter((g) => !added.some((a) => a.id === g.id)).map((g) => ({ username: g.email, name: g.name })), 'update', tz);
    notifyOutside(req.user, saved, outside.removed, 'cancel', opts);
    touch([req.user.id, ...guestsOf(e.id).map((g) => g.id), ...removed]);
    // Rooms: as asked, or (when the time changed) the same ones checked again.
    if (req.body.rooms !== undefined || (changed && roomsOf(e.id).length)) setRooms(req.user, q('SELECT * FROM events WHERE id = ?').get(e.id), req.body.rooms ?? roomsOf(e.id).map((x) => x.id));
    if (attachments && !guests) shareAttachments(req.user, e.id);
    res.json({ ...saved, attachments: attachmentsFor(saved, req.user.id), role: 'organizer', guests: allGuests(e.id), rooms: roomsOf(e.id), reminders: remindersOf(e.id, req.user.id) });
  });

  // Your own reminders of an event you organise or are invited to.
  r.put('/:id/reminders', (req, res) => {
    const ev = q(`SELECT e.id, e.owner_id FROM events e LEFT JOIN event_guests g ON g.event_id = e.id AND g.user_id = ?
                  WHERE e.id = ? AND (e.owner_id = ? OR g.user_id IS NOT NULL)`).get(req.user.id, req.params.id, req.user.id);
    if (!ev) throw notFound();
    const reminders = setReminders(ev.id, req.user.id, req.body.reminders);
    touch([req.user.id]);
    res.json({ reminders });
  });

  r.delete('/:id', (req, res) => {
    const ev = q('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!ev) throw notFound();
    const guests = guestsOf(ev.id);
    const outside = outsideOf(ev.id);
    const gone = { ...outEvent(ev), sequence: ev.sequence + 1 };
    notifyOutside(req.user, gone, outside, 'cancel', { base: baseUrl(req), tz: req.query.tz || ev.tz }); // before the guest list goes
    q('DELETE FROM events WHERE id = ?').run(ev.id);
    q('DELETE FROM events WHERE recur_parent = ? AND owner_id = ?').run(ev.id, req.user.id); // its changed occurrences go with the series
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

/** No account needed: people outside the server answer their invitation. Mounted at /api/public/invites. */
export function publicInviteRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const find = (token) => {
    const g = q(`SELECT g.email, g.status, g.token, e.*, o.name AS organizer_name, o.username AS organizer_email, o.disabled AS organizer_disabled
                 FROM event_outside_guests g JOIN events e ON e.id = g.event_id JOIN users o ON o.id = e.owner_id WHERE g.token = ?`).get(String(token || ''));
    if (!g || g.organizer_disabled) throw new HttpError(404, 'This invitation is no longer valid. The event may have been cancelled, or you were taken off the guest list.');
    return g;
  };
  const shown = (g) => ({
    title: g.title, start: g.start, end: g.end, all_day: !!g.all_day, location: g.location, description: g.description,
    rrule: g.rrule ? JSON.parse(g.rrule) : null, when: whenText(outEvent(g), g.tz), email: g.email, status: g.status,
    organizer: { name: g.organizer_name, email: g.organizer_email },
  });

  r.get('/:token', (req, res) => res.json(shown(find(req.params.token))));

  r.post('/:token/answer', (req, res) => {
    const g = find(req.params.token);
    const status = String(req.body.status || '');
    if (!ANSWERS.includes(status)) throw bad('Answer yes, maybe or no');
    q('UPDATE event_outside_guests SET status = ?, answered_at = ? WHERE token = ?').run(status, Date.now(), g.token);
    touch([g.owner_id]);
    res.json(shown({ ...g, status }));
  });

  // "Add to my calendar" for apps that didn't pick up the emailed invitation.
  r.get('/:token/ics', (req, res) => {
    const g = find(req.params.token);
    const e = outEvent(g);
    const ics = buildIcs(e, { method: 'PUBLISH', uid: icsUid(e), sequence: g.sequence || 0, tz: g.tz,
      organizer: { name: g.organizer_name, email: g.organizer_email }, attendees: [{ email: g.email, status: g.status }] });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${String(g.title).replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'event'}.ics"`);
    res.send(ics);
  });
  return r;
}
