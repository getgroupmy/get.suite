// A calendar file both ways: import an .ics exported from Google Calendar, Outlook or Apple
// Calendar (all its events, with repeats, exceptions and reminders), and export your own events as
// one .ics. Imported events keep their UID, so importing the same file twice adds nothing new.
import { q, tx } from './db.js';
import { uid } from './util.js';
import { parseIcsEvent, zoneOrUtc } from './ics.js';
import { setReminders } from './reminders.js';
import { icsOf, syncOverrides } from './dav.js';

export const MAX_IMPORT = 5000;

/** One small calendar per event (its main VEVENT and changed occurrences, with the time zones). */
export function splitCalendar(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const zones = raw.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/gi) || [];
  const groups = new Map();
  let n = 0;
  for (const ev of raw.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || []) {
    const id = (/\nUID:(.*)/i.exec(ev)?.[1] || '').trim() || `no-uid-${n++}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(ev);
  }
  return [...groups.values()].map((evs) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...zones, ...evs, 'END:VCALENDAR'].join('\r\n'));
}

const repeatUntil = (e) => (e.rrule ? (e.rrule.until !== undefined ? e.rrule.until + (e.end - e.start) : null) : null);

/** Add the file's events to this person's calendar: { added, skipped, failed }. */
export function importCalendar(userId, text, tz = 'UTC') {
  if (!/BEGIN:VCALENDAR/i.test(String(text || ''))) return { error: 'This isn’t a calendar file (.ics)' };
  const parts = splitCalendar(text);
  if (parts.length > MAX_IMPORT) return { error: `At most ${MAX_IMPORT} events can be imported at once` };
  let added = 0, skipped = 0, failed = 0;
  tx(() => {
    for (const part of parts) {
      const e = parseIcsEvent(part, { tz: zoneOrUtc(tz) });
      if (e.error) { failed++; continue; }
      if (e.uid && q('SELECT 1 FROM events WHERE owner_id = ? AND ical_uid = ?').get(userId, e.uid)) { skipped++; continue; }
      const id = uid();
      q(`INSERT INTO events (title, description, location, start, end, all_day, rrule, exdates, repeat_until, tz, id, owner_id, ical_uid, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), zoneOrUtc(e.tz), id, userId, e.uid);
      syncOverrides(id, e, userId);
      setReminders(id, userId, e.reminders);
      added++;
    }
  });
  return { added, skipped, failed };
}

/** All your own events (not invitations) as one calendar file. */
export function exportCalendar(userId) {
  const events = q('SELECT *, NULL AS my_status, ? AS for_user FROM events WHERE owner_id = ? AND recur_parent IS NULL ORDER BY start').all(userId, userId);
  const zones = new Map();
  const bodies = [];
  for (const e of events) {
    const one = icsOf(e).replace(/\r\n[ \t]/g, '\u0000'); // keep folded lines whole while splitting
    for (const z of one.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/g) || []) {
      const tzid = /TZID:([^\r\n]*)/.exec(z)?.[1];
      if (tzid && !zones.has(tzid)) zones.set(tzid, z);
    }
    bodies.push(...(one.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []));
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//Calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Workspace', ...zones.values(), ...bodies, 'END:VCALENDAR', '']
    .join('\r\n').replace(/\u0000/g, '\r\n ');
}
