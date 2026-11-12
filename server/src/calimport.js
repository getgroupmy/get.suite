// A calendar file both ways: import an .ics exported from Google Calendar, Outlook or Apple
// Calendar (all its events, with repeats, exceptions and reminders), and export your own events as
// one .ics. Imported events keep their UID, so importing the same file twice adds nothing new.
import { q, tx } from './db.js';
import { uid } from './util.js';
import { parseIcsEvent, zoneOrUtc } from './ics.js';
import { setReminders } from './reminders.js';
import { icsOf, syncOverrides } from './dav.js';
import { parseCsv } from './contactfiles.js';
import { createHash } from 'node:crypto';

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
export function importCalendar(userId, text, tz = 'UTC', calendarId = null, color = null) {
  if (!/BEGIN:VCALENDAR/i.test(String(text || ''))) {
    const csv = icsFromCsv(text, zoneOrUtc(tz));
    if (!csv) return { error: 'This isn’t a calendar file (.ics) or a calendar exported as CSV' };
    if (csv.error) return csv;
    text = csv.ics;
  }
  const parts = splitCalendar(text);
  if (parts.length > MAX_IMPORT) return { error: `At most ${MAX_IMPORT} events can be imported at once` };
  let added = 0, skipped = 0, failed = 0;
  tx(() => {
    for (const part of parts) {
      const e = parseIcsEvent(part, { tz: zoneOrUtc(tz) });
      if (e.error) { failed++; continue; }
      if (e.uid && q('SELECT 1 FROM events WHERE owner_id = ? AND ical_uid = ?').get(userId, e.uid)) { skipped++; continue; }
      const id = uid();
      q(`INSERT INTO events (title, description, location, start, end, all_day, rrule, exdates, repeat_until, tz, id, owner_id, ical_uid, color, calendar_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.title, e.description, e.location, e.start, e.end, e.all_day, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), zoneOrUtc(e.tz), id, userId, e.uid, color, calendarId);
      syncOverrides(id, e, userId);
      setReminders(id, userId, e.reminders);
      added++;
    }
  });
  return { added, skipped, failed };
}

/** All your own events (not invitations) as one calendar file; or one of your calendars' ({ id, name }; null id: the main one). */
export function exportCalendar(userId, only) {
  const events = only === undefined
    ? q('SELECT *, NULL AS my_status, ? AS for_user FROM events WHERE owner_id = ? AND recur_parent IS NULL ORDER BY start').all(userId, userId)
    : q('SELECT *, NULL AS my_status, ? AS for_user FROM events WHERE owner_id = ? AND recur_parent IS NULL AND calendar_id IS ? ORDER BY start').all(userId, userId, only.id);
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
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${String(only?.name || 'Workspace').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ')}`, ...zones.values(), ...bodies, 'END:VCALENDAR', '']
    .join('\r\n').replace(/\u0000/g, '\r\n ');
}

// A calendar exported as CSV (Outlook's File → Export, or the layout Google Calendar imports): Subject, Start Date,
// Start Time, End Date, End Time, All day event, Description, Location. Dates are month first (12/25/2026) as those
// apps write them, or 2026-12-25; times 9:00 AM or 14:30. Each row becomes an event in your time zone, with a UID
// made from its subject and start so importing the same file twice adds nothing.
const CSV_COLS = {
  title: ['subject', 'title', 'event', 'summary', 'name'],
  startDate: ['start date', 'date', 'start'], startTime: ['start time', 'time'],
  endDate: ['end date', 'end'], endTime: ['end time'],
  allDay: ['all day event', 'all day', 'all-day'],
  description: ['description', 'notes', 'details'], location: ['location', 'where', 'place'],
};

function csvDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  let [a, b, y] = [+m[1], +m[2], +m[3]];
  if (y < 100) y += 2000;
  if (a > 12) [a, b] = [b, a]; // 25/12/2026 can only be day first
  return a >= 1 && a <= 12 && b >= 1 && b <= 31 ? [y, a, b] : null;
}

function csvTime(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  return h < 24 && min < 60 ? [h, min] : null;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** { ics } for a calendar CSV, { error } when it looks like one but has no usable rows, or null when it isn't one. */
export function icsFromCsv(text, zone = 'UTC') {
  const rows = parseCsv(String(text || ''));
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(CSV_COLS).map(([k, names]) => [k, names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1]));
  if (col.title < 0 || col.startDate < 0) return null;
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//CSV import//EN'];
  let n = 0;
  for (const r of rows.slice(1)) {
    const title = get(r, 'title').slice(0, 500);
    const d = csvDate(get(r, 'startDate'));
    if (!title || !d) continue;
    const t = csvTime(get(r, 'startTime'));
    const allDay = /^(true|yes|y|1|x)$/i.test(get(r, 'allDay')) || !t;
    const ed = csvDate(get(r, 'endDate')) || d;
    const et = csvTime(get(r, 'endTime'));
    const stamp = ([y, m, dd]) => `${y}${pad(m)}${pad(dd)}`;
    let start, end;
    if (allDay) {
      // CSV all-day ends are the last day itself; .ics ends the day after.
      const last = Date.UTC(ed[0], ed[1] - 1, ed[2]) >= Date.UTC(d[0], d[1] - 1, d[2]) ? ed : d;
      const after = new Date(Date.UTC(last[0], last[1] - 1, last[2] + 1));
      start = `DTSTART;VALUE=DATE:${stamp(d)}`;
      end = `DTEND;VALUE=DATE:${after.getUTCFullYear()}${pad(after.getUTCMonth() + 1)}${pad(after.getUTCDate())}`;
    } else {
      const s0 = `${stamp(d)}T${pad(t[0])}${pad(t[1])}00`;
      let e0 = et ? `${stamp(ed)}T${pad(et[0])}${pad(et[1])}00` : null;
      if (!e0 || e0 <= s0) { const x = new Date(Date.UTC(d[0], d[1] - 1, d[2], t[0] + 1, t[1])); e0 = `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`; }
      start = `DTSTART;TZID=${zone}:${s0}`;
      end = `DTEND;TZID=${zone}:${e0}`;
    }
    const id = createHash('sha1').update(`${title}\n${start}`).digest('hex').slice(0, 24);
    out.push('BEGIN:VEVENT', `UID:csv-${id}@workspace`, `SUMMARY:${icsText(title)}`, start, end);
    if (get(r, 'description')) out.push(`DESCRIPTION:${icsText(get(r, 'description').slice(0, 10000))}`);
    if (get(r, 'location')) out.push(`LOCATION:${icsText(get(r, 'location').slice(0, 500))}`);
    out.push('END:VEVENT');
    n++;
  }
  if (!n) return { error: 'No events found: each row needs a Subject and a Start Date' };
  if (n > MAX_IMPORT) return { error: `At most ${MAX_IMPORT} events can be imported at once` };
  out.push('END:VCALENDAR');
  return { ics: out.join('\r\n') };
}

/** Your events as a CSV spreadsheet in the same layout (Excel, Outlook, Google Calendar's import, or back here): one row per event, times in `zone`. */
export function exportCalendarCsv(userId, only, zone = 'UTC') {
  const events = only === undefined
    ? q('SELECT * FROM events WHERE owner_id = ? AND recur_parent IS NULL ORDER BY start').all(userId)
    : q('SELECT * FROM events WHERE owner_id = ? AND recur_parent IS NULL AND calendar_id IS ? ORDER BY start').all(userId, only.id);
  const parts = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const day = (p) => `${p.month}/${p.day}/${p.year}`;
  const time = (p) => `${p.hour}:${p.minute} ${p.dayPeriod}`;
  const cell = (v) => { const s = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  const freq = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' };
  const rows = [['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All day event', 'Description', 'Location', 'Repeats']];
  for (const e of events) {
    const tz = e.all_day ? zoneOrUtc(e.tz) : zone;
    const s = parts(e.start, tz), en = parts(e.all_day ? e.end - 1 : e.end, tz);
    let rule = null;
    try { rule = e.rrule ? JSON.parse(e.rrule) : null; } catch { rule = null; }
    rows.push([e.title, day(s), e.all_day ? '' : time(s), day(en), e.all_day ? '' : time(en), e.all_day ? 'True' : 'False', e.description || '', e.location || '',
      rule ? freq[String(rule.freq || '').toUpperCase()] || 'Yes' : '']);
  }
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
