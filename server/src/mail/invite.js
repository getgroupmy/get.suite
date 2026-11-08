// Invitations from other calendars arriving by email (Outlook, Gmail, Apple...): the calendar file in
// the message is read, shown in Mail with Yes / Maybe / No, and answering puts the event on your
// calendar (or takes it off) and emails the organizer a standard reply (METHOD:REPLY).
import { q, tx } from '../db.js';
import { uid as newId } from '../util.js';
import { parseIcsEvent, zoneOrUtc } from '../ics.js';
import { syncOverrides } from '../dav.js';

if (!q('PRAGMA table_info(events)').all().some((c) => c.name === 'ext_organizer')) q('ALTER TABLE events ADD COLUMN ext_organizer TEXT').run(); // { name, email } of an invitation from outside
if (!q('PRAGMA table_info(events)').all().some((c) => c.name === 'ext_status')) q('ALTER TABLE events ADD COLUMN ext_status TEXT').run(); // yes | maybe | no: your answer to it

const PARTSTAT = { yes: 'ACCEPTED', maybe: 'TENTATIVE', no: 'DECLINED' };
const FROM_PARTSTAT = { ACCEPTED: 'yes', TENTATIVE: 'maybe', DECLINED: 'no' };

/** The calendar file in a parsed message (an invitation or a cancellation), or null. */
export function calendarPartOf(parsed) {
  const a = (parsed.attachments || []).find((x) => /^(text\/calendar|application\/ics)$/i.test(x.contentType || '') || /\.ics$/i.test(x.filename || ''));
  if (!a?.content) return null;
  const text = a.content.toString('utf8');
  return /BEGIN:VEVENT/i.test(text) ? text : null;
}

/** Unfolded lines of the main VEVENT, as written. */
function mainEventLines(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const evs = raw.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  const main = evs.find((e) => !/\nRECURRENCE-ID[;:]/i.test(e)) || evs[0] || '';
  return main.split('\n');
}
const nameOf = (line) => /^([A-Z-]+)/i.exec(line)?.[1].toUpperCase();
const mailtoOf = (line) => /:mailto:([^\s;]+)\s*$/i.exec(line)?.[1].toLowerCase() || null;
const cnOf = (line) => { const m = /;CN=("([^"]*)"|[^;:]*)/i.exec(line); return m ? (m[2] ?? m[1]).trim() : null; };

/**
 * What an invitation says, for the person with these addresses: { method, uid, sequence, event,
 * organizer: { name, email }, mine: { email, answer } | null } or null if it isn't one.
 */
export function readInvite(text, myAddresses = [], tz = 'UTC') {
  if (!text) return null;
  const method = (/\nMETHOD:([A-Z-]+)/i.exec(`\n${String(text).replace(/\r/g, '')}`)?.[1] || 'PUBLISH').toUpperCase();
  const e = parseIcsEvent(text, { tz: zoneOrUtc(tz) });
  if (e.error) return null;
  const lines = mainEventLines(text);
  const orgLine = lines.find((l) => nameOf(l) === 'ORGANIZER');
  const organizer = orgLine ? { name: cnOf(orgLine) || mailtoOf(orgLine), email: mailtoOf(orgLine) } : null;
  const mine = new Set(myAddresses.map((x) => String(x).toLowerCase()));
  const meLine = lines.find((l) => nameOf(l) === 'ATTENDEE' && mine.has(mailtoOf(l)));
  const status = meLine && /;PARTSTAT=([A-Z-]+)/i.exec(meLine)?.[1].toUpperCase();
  const seq = Number(/^SEQUENCE:(\d+)/im.exec(lines.join('\n'))?.[1] || 0);
  return { method, uid: e.uid, sequence: seq, event: e, organizer, mine: meLine ? { email: mailtoOf(meLine), answer: FROM_PARTSTAT[status] || null } : null, attendees: lines.filter((l) => nameOf(l) === 'ATTENDEE').length };
}

/** The calendar file answering an invitation (METHOD:REPLY), from `me` ({ name, email }). */
export function replyIcs(text, me, answer, now = Date.now()) {
  const lines = mainEventLines(text);
  const keep = ['UID', 'SEQUENCE', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'ORGANIZER', 'RECURRENCE-ID'];
  const body = lines.filter((l) => keep.includes(nameOf(l)));
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const cn = String(me.name || me.email).replace(/[";:,]/g, ' ').trim();
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NAS Workspace//Calendar//EN', 'METHOD:REPLY', 'BEGIN:VEVENT', ...body, `DTSTAMP:${stamp}`,
    `ATTENDEE;CN=${cn};PARTSTAT=${PARTSTAT[answer]}:mailto:${me.email}`, 'END:VEVENT', 'END:VCALENDAR'];
  // Fold at 75 octets (roughly; continuation lines start with a space).
  return out.flatMap((l) => { const parts = []; let s = l; while (s.length > 74) { parts.push(s.slice(0, 74)); s = ` ${s.slice(74)}`; } parts.push(s); return parts; }).join('\r\n') + '\r\n';
}

/** The event this invitation already made on your calendar, if any. */
export const eventForInvite = (userId, inviteUid) => (inviteUid ? q('SELECT id, ext_status, sequence FROM events WHERE owner_id = ? AND ical_uid = ? AND recur_parent IS NULL').get(userId, inviteUid) : null);

const repeatUntil = (e) => (e.rrule ? (e.rrule.until !== undefined ? e.rrule.until + (e.end - e.start) : null) : null);

/**
 * Put the invitation on your calendar with your answer (or change it there); "no" (or a cancellation)
 * takes it off. Returns the event id, or null when there's none now.
 */
export function saveInvite(userId, inv, answer) {
  const have = eventForInvite(userId, inv.uid);
  const e = inv.event;
  if (answer === 'no' || answer === 'remove') {
    if (have) q('DELETE FROM events WHERE id = ? OR recur_parent = ?').run(have.id, have.id);
    return null;
  }
  const vals = [e.title, e.description, e.location, e.start, e.end, e.all_day, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), zoneOrUtc(e.tz), JSON.stringify(inv.organizer || null), answer];
  let id = have?.id;
  tx(() => {
    if (id) q('UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, rrule = ?, exdates = ?, repeat_until = ?, tz = ?, ext_organizer = ?, ext_status = ?, sequence = ? WHERE id = ?').run(...vals, inv.sequence, id);
    else {
      id = newId();
      q(`INSERT INTO events (title, description, location, start, end, all_day, rrule, exdates, repeat_until, tz, ext_organizer, ext_status, sequence, id, owner_id, ical_uid, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(...vals, inv.sequence, id, userId, inv.uid);
    }
    syncOverrides(id, e, userId);
  });
  return id;
}
