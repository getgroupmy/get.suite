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
export function buildIcs(e, { method = 'REQUEST', uid, sequence = 0, organizer, attendees = [], tz, now = Date.now(), overrides = [] }) {
  const zone = zoneOrUtc(tz);
  const repeats = !!e.rrule && !e.all_day && zone !== 'UTC';
  const start = firstStart(e, zone), end = start + (e.end - e.start);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NAS Workspace//Calendar//EN', 'CALSCALE:GREGORIAN', ...(method ? [`METHOD:${method}`] : [])];
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
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  // Single occurrences changed on their own: the same UID, with the original start as RECURRENCE-ID.
  for (const o of e.rrule ? overrides : []) {
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`, `SEQUENCE:${o.sequence || 0}`,
      e.all_day ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(o.recurrenceId, zone)}` : repeats ? `RECURRENCE-ID;TZID=${zone}:${localStamp(o.recurrenceId, zone)}` : `RECURRENCE-ID:${utcStamp(o.recurrenceId)}`,
      o.all_day ? `DTSTART;VALUE=DATE:${dateStamp(o.start, zone)}` : when('DTSTART', o.start),
      o.all_day ? `DTEND;VALUE=DATE:${dateStamp(o.end, zone, 1)}` : when('DTEND', o.end),
      `SUMMARY:${escapeText(o.title)}`, ...(o.location ? [`LOCATION:${escapeText(o.location)}`] : []), ...(o.description ? [`DESCRIPTION:${escapeText(o.description)}`] : []),
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return fold(lines);
}

// ---- reading calendar files (from phones and calendar apps, over CalDAV) ----

/** Unfold and split into { name, params, value } lines. */
export function contentLines(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean).map((line) => {
    // NAME;P=V;P="V:x":value  (a colon inside a quoted parameter isn't the separator)
    let i = 0, q = false;
    for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    const params = Object.fromEntries(ps.map((p) => { const k = p.indexOf('='); return [p.slice(0, k).toUpperCase(), p.slice(k + 1).replace(/^"|"$/g, '')]; }));
    return { name: name.toUpperCase(), params, value };
  });
}
export const unescapeText = (s) => String(s || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** Wall-clock time in a zone to UTC milliseconds (correct around clock changes). */
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, zone = 'UTC') {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetAt(guess, zone) * 6e4;
  t = guess - offsetAt(t, zone) * 6e4;
  return t;
}

/** A DATE or DATE-TIME value: { ms, date (all day) }. Floating times use `fallbackZone`. */
export function parseWhen({ value, params }, fallbackZone = 'UTC') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === 'DATE') return { ms: zonedToUtc(+y, +mo, +d, 0, 0, 0, fallbackZone), date: true, ymd: [+y, +mo, +d] };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), date: false };
  return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, +s, zoneOrUtc(params.TZID || fallbackZone)), date: false };
}

/**
 * The event in a calendar file, as Workspace stores it, or { error }. Repeat rules Workspace can't
 * show (e.g. "the second Monday of each month") come through as a one-off on the first date.
 */
export function parseIcsEvent(text, { tz = 'UTC' } = {}) {
  const all = contentLines(text);
  // Only the main event; changed single occurrences (RECURRENCE-ID) aren't kept yet.
  const blocks = [];
  let cur = null, depth = 0;
  for (const l of all) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VEVENT') { cur = []; depth = 0; continue; }
    if (cur && l.name === 'BEGIN') depth++;
    if (cur && l.name === 'END' && l.value.toUpperCase() === 'VEVENT' && depth === 0) { blocks.push(cur); cur = null; continue; }
    if (cur && l.name === 'END') { depth--; continue; }
    if (cur && depth === 0) cur.push(l);
  }
  const ev = blocks.find((b) => !b.some((l) => l.name === 'RECURRENCE-ID'));
  if (!ev) return { error: 'No event in this calendar file' };
  const get = (n) => ev.find((l) => l.name === n);
  const zoneOf = (l) => zoneOrUtc(l?.params.TZID || tz);
  const startL = get('DTSTART');
  const start = startL && parseWhen(startL, tz);
  if (!start) return { error: 'The event has no valid start' };
  let end;
  const endL = get('DTEND'), durL = get('DURATION');
  if (endL) end = parseWhen(endL, tz);
  else if (durL) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(durL.value.trim());
    const ms = m ? ((+m[2] || 0) * 7 * 864e5 + (+m[3] || 0) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3) : 0;
    end = { ms: start.ms + ms, date: start.date };
  }
  const allDay = start.date;
  let endMs;
  if (allDay) {
    // DTEND is the day after the last day (exclusive); Workspace keeps the last moment of the last day.
    const lastDayStart = end ? end.ms : start.ms + 864e5;
    endMs = Math.max(start.ms + 864e5, lastDayStart) - 1;
  } else endMs = Math.max(start.ms, end ? end.ms : start.ms);
  const out = {
    uid: get('UID')?.value.trim() || null,
    title: unescapeText(get('SUMMARY')?.value || '').trim().slice(0, 200) || 'Untitled event',
    location: unescapeText(get('LOCATION')?.value || '').slice(0, 300) || null,
    description: unescapeText(get('DESCRIPTION')?.value || '').slice(0, 5000) || null,
    start: start.ms, end: endMs, all_day: allDay ? 1 : 0, tz: allDay ? tz : zoneOf(startL), rrule: null, exdates: [],
  };
  const rr = get('RRULE');
  if (rr) {
    const p = Object.fromEntries(rr.value.split(';').map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
    const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[p.FREQ];
    const days = p.BYDAY ? p.BYDAY.split(',') : [];
    const plainDays = days.every((d) => /^(SU|MO|TU|WE|TH|FR|SA)$/.test(d));
    const startDay = new Date(start.ms + offsetAt(start.ms, out.tz) * 6e4).getUTCDate();
    const supported = freq && plainDays && (!days.length || freq === 'weekly') && !p.BYSETPOS && !p.BYYEARDAY && !p.BYWEEKNO && !p.BYHOUR
      && (!p.BYMONTHDAY || (freq !== 'daily' && freq !== 'weekly' && p.BYMONTHDAY.split(',').length === 1 && +p.BYMONTHDAY === startDay))
      && (!p.BYMONTH || freq === 'yearly');
    if (supported) {
      const rule = { freq };
      if (+p.INTERVAL > 1) rule.interval = Math.min(99, +p.INTERVAL);
      if (days.length) rule.byday = [...new Set(days.map((d) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(d)))].sort();
      if (p.COUNT) rule.count = Math.max(1, Math.min(999, +p.COUNT));
      else if (p.UNTIL) { const u = parseWhen({ value: p.UNTIL, params: {} }, out.tz); if (u) rule.until = u.date ? u.ms + 864e5 - 1 : u.ms; }
      out.rrule = rule;
      for (const l of ev.filter((x) => x.name === 'EXDATE')) {
        for (const v of l.value.split(',')) { const w = parseWhen({ value: v, params: l.params }, out.tz); if (w) out.exdates.push(w.ms); }
      }
    }
  }
  // Occurrences changed on their own (or cancelled) in the same file.
  out.overrides = [];
  for (const raw of String(text || '').replace(/\r?\n[ \t]/g, '').match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || []) {
    const ridLine = contentLines(raw).find((l) => l.name === 'RECURRENCE-ID');
    if (!ridLine) continue;
    const rid = parseWhen(ridLine, out.tz);
    if (!rid) continue;
    const cancelled = /\nSTATUS:CANCELLED/i.test(raw);
    const body = raw.split(/\r?\n/).filter((l) => !/^(RECURRENCE-ID|RRULE|EXDATE)[;:]/i.test(l)).join('\r\n');
    const o = parseIcsEvent(`BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR`, { tz: out.tz });
    if (o.error) continue;
    out.overrides.push({ recurrenceId: rid.ms, cancelled, title: o.title, location: o.location, description: o.description, start: o.start, end: o.end, all_day: o.all_day });
  }
  return out;
}
