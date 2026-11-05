// iCalendar (RFC 5545) invitations for people outside the server: Outlook, Gmail, Apple and phone
// calendars read these from an email (iTIP/iMIP: METHOD REQUEST to invite or update, CANCEL).
//
// One-off timed events are written in UTC. Repeating ones are written in the organizer's time zone
// with a VTIMEZONE (its clock changes listed one by one), so a 9:00 weekly meeting stays at 9:00
// for everyone in that zone across clock changes. All-day events use plain dates.

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A valid IANA time zone, or UTC. */
export function zoneOrUtc(tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC' }).resolvedOptions().timeZone; } catch { return 'UTC'; }
}

/** Wall-clock parts of `ms` in a zone. */
function parts(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Offset from UTC in minutes at `ms` in a zone. */
export function offsetAt(ms, zone) {
  const p = parts(ms, zone);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 6e4);
}

const utcStamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
const localStamp = (ms, zone) => { const p = parts(ms, zone); return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`; };
const dateStamp = (ms, zone, addDays = 0) => { const p = parts(ms, zone); const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + addDays)); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
const offsetText = (min) => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;

/** The zone's clock changes between two times: [{ at (ms), from, to } offsets in minutes]. */
export function transitions(zone, from, to) {
  const out = [];
  const DAY = 864e5;
  let prev = offsetAt(from, zone);
  for (let t = from + DAY; t <= to; t += DAY) {
    const cur = offsetAt(t, zone);
    if (cur === prev) continue;
    let lo = t - DAY, hi = t; // the change is in (lo, hi]: narrow it to the minute
    while (hi - lo > 6e4) { const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / 6e4)) * 6e4; if (offsetAt(mid, zone) === prev) lo = mid; else hi = mid; }
    out.push({ at: hi, from: prev, to: cur });
    prev = cur;
  }
  return out;
}

/** A VTIMEZONE covering [from, to]: each clock change as its own observance. */
export function vtimezone(zone, from, to) {
  const start = offsetAt(from, zone);
  const changes = transitions(zone, from, to);
  const standard = Math.min(start, ...changes.map((c) => c.to));
  const kind = (off) => (off > standard ? 'DAYLIGHT' : 'STANDARD');
  // Before the first change: the offset at the start of the range.
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, `BEGIN:${kind(start)}`, `DTSTART:${localStamp(from - 864e5, zone).slice(0, 8)}T000000`,
    `TZOFFSETFROM:${offsetText(start)}`, `TZOFFSETTO:${offsetText(start)}`, `END:${kind(start)}`];
  for (const c of changes) {
    // DTSTART is the wall-clock time just before the change, in the old offset.
    const d = new Date(c.at + c.from * 6e4);
    const wall = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
    lines.push(`BEGIN:${kind(c.to)}`, `DTSTART:${wall}`, `TZOFFSETFROM:${offsetText(c.from)}`, `TZOFFSETTO:${offsetText(c.to)}`, `END:${kind(c.to)}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/** Text value escaping (backslash, semicolon, comma, newline). */
export const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Quoted parameter value (CN="..."); quotes and control characters can't appear in one. */
const param = (s) => `"${String(s ?? '').replace(/["\r\n\x00-\x1f]/g, ' ').trim()}"`;

/** Fold lines at 75 octets (never inside a UTF-8 character), with CRLF endings. */
export function fold(lines) {
  return lines.map((line) => {
    const out = [];
    let cur = '', size = 0;
    for (const ch of line) {
      const n = Buffer.byteLength(ch);
      if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
      cur += ch; size += n;
    }
    out.push(cur);
    return out.join('\r\n ');
  }).join('\r\n') + '\r\n';
}

/**
 * The first real occurrence: a weekly series on set weekdays that starts on another day begins on
 * the next listed weekday (RFC 5545 would otherwise count the start date itself as an extra one).
 */
function firstStart(e, zone) {
  const r = e.rrule;
  if (!r || r.freq !== 'weekly' || !r.byday?.length) return e.start;
  for (let i = 0; i < 7; i++) {
    const t = e.start + i * 864e5;
    // Whole days in wall-clock time: correct the step if the clocks changed in between.
    const fixed = t + (offsetAt(e.start, zone) - offsetAt(t, zone)) * 6e4;
    if (r.byday.includes(parts(fixed, zone).wd)) return fixed;
  }
  return e.start;
}

/**
 * The calendar file for an event. `method` is 'REQUEST' (invite or update), 'CANCEL', or
 * 'PUBLISH' (a plain "add to calendar" file). `attendees`: [{ email, name, status }].
 */
export function buildIcs(e, { method = 'REQUEST', uid, sequence = 0, organizer, attendees = [], tz, now = Date.now() }) {
  const zone = zoneOrUtc(tz);
  const repeats = !!e.rrule && !e.all_day && zone !== 'UTC';
  const start = firstStart(e, zone), end = start + (e.end - e.start);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NAS Workspace//Calendar//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`];
  if (repeats) {
    const last = e.rrule.until ?? start + 10 * 365 * 864e5;
    lines.push(...vtimezone(zone, start, Math.max(last, start) + 864e5));
  }
  const when = (name, ms) => (e.all_day ? `${name};VALUE=DATE:${dateStamp(ms, zone, name === 'DTEND' ? 1 : 0)}`
    : repeats ? `${name};TZID=${zone}:${localStamp(ms, zone)}` : `${name}:${utcStamp(ms)}`);
  lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`, `SEQUENCE:${sequence}`,
    when('DTSTART', start), e.all_day ? `DTEND;VALUE=DATE:${dateStamp(e.end, zone, 1)}` : when('DTEND', end));
  if (e.rrule) {
    const r = e.rrule;
    const rule = [`FREQ=${r.freq.toUpperCase()}`];
    if (r.interval > 1) rule.push(`INTERVAL=${r.interval}`);
    if (r.freq === 'weekly' && r.byday?.length) rule.push(`BYDAY=${r.byday.map((d) => DAYS[d]).join(',')}`);
    if (r.until !== undefined) rule.push(`UNTIL=${e.all_day ? dateStamp(r.until, zone) : utcStamp(r.until)}`);
    if (r.count) rule.push(`COUNT=${r.count}`);
    lines.push(`RRULE:${rule.join(';')}`);
    for (const x of e.exdates || []) lines.push(e.all_day ? `EXDATE;VALUE=DATE:${dateStamp(x, zone)}` : repeats ? `EXDATE;TZID=${zone}:${localStamp(x, zone)}` : `EXDATE:${utcStamp(x)}`);
  }
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (organizer) lines.push(`ORGANIZER;CN=${param(organizer.name)}:mailto:${organizer.email}`);
  const PARTSTAT = { yes: 'ACCEPTED', maybe: 'TENTATIVE', no: 'DECLINED' };
  for (const a of attendees) {
    lines.push(`ATTENDEE;CN=${param(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=${PARTSTAT[a.status] || 'NEEDS-ACTION'};RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return fold(lines);
}
