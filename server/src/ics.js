// iCalendar (RFC 5545) invitations for people outside the server: Outlook, Gmail, Apple and phone
// calendars read these from an email (iTIP/iMIP: METHOD REQUEST to invite or update, CANCEL).
//
// One-off timed events are written in UTC. Repeating ones are written in the organizer's time zone
// with a VTIMEZONE (its clock changes listed one by one), so a 9:00 weekly meeting stays at 9:00
// for everyone in that zone across clock changes. All-day events use plain dates.

import { WINDOWS_ZONES } from './windowszones.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A valid IANA time zone, or UTC. */
export function zoneOrUtc(tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC' }).resolvedOptions().timeZone; } catch { return 'UTC'; }
}

const formatters = new Map();
const formatter = (zone) => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(zone, f);
  }
  return f;
};

/** Wall-clock parts of `ms` in a zone (an IANA name, or a zone read from a file's VTIMEZONE). */
function parts(ms, zone) {
  if (typeof zone === 'object') {
    const d = new Date(ms + zone.offsetAt(ms) * 6e4);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() };
  }
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Offset from UTC in minutes at `ms` in a zone. */
export function offsetAt(ms, zone) {
  if (typeof zone === 'object') return zone.offsetAt(ms);
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
export function buildIcs(e, { method = 'REQUEST', uid, sequence = 0, organizer, attendees = [], tz, now = Date.now(), overrides = [], alarms = [] }) {
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
  // Its video meeting, as the event's link (phones show it); only with a known public address.
  if (e.meet_code && process.env.PUBLIC_URL) lines.push(`URL:${process.env.PUBLIC_URL.replace(/\/+$/, '')}/meet/${e.meet_code}`);
  if (organizer) lines.push(`ORGANIZER;CN=${param(organizer.name)}:mailto:${organizer.email}`);
  const PARTSTAT = { yes: 'ACCEPTED', maybe: 'TENTATIVE', no: 'DECLINED' };
  for (const a of attendees) {
    lines.push(`ATTENDEE;CN=${param(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=${PARTSTAT[a.status] || 'NEEDS-ACTION'};RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE');
  // Reminders, so the phone reminds too.
  for (const m of alarms) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:${beforeStart(m)}`, 'END:VALARM');
  lines.push('END:VEVENT');
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

/** Minutes before the start as an iCalendar duration: 10 → -PT10M, 60 → -PT1H, 1440 → -P1D, 0 → PT0S. */
export function beforeStart(m) {
  if (!m) return 'PT0S';
  if (m % 10080 === 0) return `-P${m / 10080}W`;
  if (m % 1440 === 0) return `-P${m / 1440}D`;
  if (m % 60 === 0) return `-PT${m / 60}H`;
  return `-PT${m}M`;
}

/** The reminders (minutes before the start) in an event's VALARMs. Reminders after the start or from its end are left out. */
export function alarmsIn(eventText, startMs) {
  const out = [];
  for (const [, body] of String(eventText).matchAll(/BEGIN:VALARM([\s\S]*?)END:VALARM/gi)) {
    const t = contentLines(body).find((l) => l.name === 'TRIGGER');
    if (!t || (t.params.RELATED || '').toUpperCase() === 'END') continue;
    let minutes = null;
    if ((t.params.VALUE || '').toUpperCase() === 'DATE-TIME') { const w = parseWhen(t, 'UTC'); if (w && startMs !== undefined) minutes = Math.round((startMs - w.ms) / 6e4); }
    else {
      const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(t.value.trim());
      if (m) { const total = (+m[2] || 0) * 10080 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.round((+m[6] || 0) / 60); minutes = m[1] === '-' ? total : total === 0 ? 0 : -total; }
    }
    if (minutes !== null && minutes >= 0) out.push(minutes);
  }
  return [...new Set(out)].sort((a, b) => a - b);
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
export function parseWhen({ value, params }, fallbackZone = 'UTC', zones = null) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === 'DATE') return { ms: zonedToUtc(+y, +mo, +d, 0, 0, 0, fallbackZone), date: true, ymd: [+y, +mo, +d] };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), date: false };
  const zone = params.TZID ? (zones ? zones(params.TZID) : resolveZone(params.TZID, {}, fallbackZone)) : fallbackZone;
  return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, +s, zone), date: false };
}

// ---- time zones named in calendar files: IANA names, Windows names (Outlook), and anything else
// through the file's own VTIMEZONE (its rules for when the clocks change).

const isIana = (tz) => { try { formatter(tz); return true; } catch { return false; } };
const WINDOWS_LOWER = Object.fromEntries(Object.entries(WINDOWS_ZONES).map(([k, v]) => [k.toLowerCase(), v]));

/** The IANA zone a TZID names, if it names one: "Europe/Berlin", "W. Europe Standard Time", "/mozilla.org/…/Europe/Berlin". */
export function ianaFor(tzid) {
  const t = String(tzid || '').trim().replace(/^"|"$/g, '');
  if (!t) return null;
  if (isIana(t) && !/^[+-]?\d/.test(t)) return t;
  const w = WINDOWS_LOWER[t.toLowerCase()];
  if (w) return w;
  const segs = t.split('/').filter(Boolean); // a prefixed name, e.g. /mozilla.org/20050126_1/America/New_York
  for (let i = 1; i < segs.length; i++) { const tail = segs.slice(i).join('/'); if (tail.includes('/') && isIana(tail)) return tail; }
  return null;
}

const DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** Days of month `mo` (1-12) in year `y` matching an RRULE's BYDAY and BYMONTHDAY. */
function ruleDays(y, mo, byday, bymonthday) {
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let days = Array.from({ length: last }, (_, i) => i + 1);
  if (bymonthday) { const want = bymonthday.split(',').map(Number).map((n) => (n < 0 ? last + 1 + n : n)); days = days.filter((d) => want.includes(d)); }
  if (byday) {
    const picked = new Set();
    for (const part of byday.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim().toUpperCase());
      if (!m) continue;
      const wd = DAY_NAMES.indexOf(m[2]);
      const hits = days.filter((d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd);
      if (!m[1]) hits.forEach((d) => picked.add(d));
      else { const n = +m[1]; const d = n > 0 ? hits[n - 1] : hits[hits.length + n]; if (d) picked.add(d); }
    }
    days = days.filter((d) => picked.has(d));
  }
  return days;
}

/** A zone from a VTIMEZONE's observances: { offsetAt(utcMs) } in minutes east of UTC. */
function zoneFromDefinition(lines) {
  const obs = [];
  let cur = null;
  for (const l of lines) {
    const v = l.value.trim();
    if (l.name === 'BEGIN' && /^(STANDARD|DAYLIGHT)$/i.test(v)) { cur = { rdates: [] }; continue; }
    if (l.name === 'END' && /^(STANDARD|DAYLIGHT)$/i.test(v)) { if (cur && cur.start && Number.isFinite(cur.to)) obs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const off = (x) => { const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(x); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : NaN; };
    const local = (x) => { const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(x); return m && [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)]; };
    if (l.name === 'DTSTART') cur.start = local(v);
    else if (l.name === 'TZOFFSETFROM') cur.from = off(v);
    else if (l.name === 'TZOFFSETTO') cur.to = off(v);
    else if (l.name === 'RRULE') cur.rule = Object.fromEntries(v.split(';').map((x) => x.split('=')).map(([k, val]) => [k.toUpperCase(), val]));
    else if (l.name === 'RDATE') for (const x of v.split(',')) { const d = local(x); if (d) cur.rdates.push(d); }
  }
  if (!obs.length) return null;
  for (const o of obs) if (!Number.isFinite(o.from)) o.from = o.to;
  const utcOf = (d, o) => Date.UTC(d[0], d[1] - 1, d[2], d[3], d[4], d[5]) - o.from * 6e4; // onsets are in the time before the change
  const onsetsIn = (y) => {
    const out = [];
    for (const o of obs) {
      const first = utcOf(o.start, o);
      if (y === o.start[0]) out.push([first, o.to]);
      for (const d of o.rdates) if (d[0] === y) out.push([utcOf(d, o), o.to]);
      const r = o.rule;
      if (!r || (r.FREQ || '').toUpperCase() !== 'YEARLY' || y < o.start[0]) continue;
      const until = r.UNTIL ? parseWhen({ value: r.UNTIL, params: {} }, 'UTC')?.ms : Infinity;
      if (r.COUNT && y >= o.start[0] + Number(r.COUNT)) continue;
      const months = r.BYMONTH ? r.BYMONTH.split(',').map(Number) : [o.start[1]];
      for (const mo of months) {
        const days = r.BYDAY || r.BYMONTHDAY ? ruleDays(y, mo, r.BYDAY, r.BYMONTHDAY) : [o.start[2]];
        for (const day of days) { const t = utcOf([y, mo, day, o.start[3], o.start[4], o.start[5]], o); if (t >= first && t <= until) out.push([t, o.to]); }
      }
    }
    return out;
  };
  const cache = new Map();
  const yearOnsets = (y) => { if (!cache.has(y)) cache.set(y, onsetsIn(y)); return cache.get(y); };
  const earliest = obs.reduce((a, o) => (utcOf(o.start, o) < utcOf(a.start, a) ? o : a));
  return {
    offsetAt(ms) {
      const y = new Date(ms).getUTCFullYear();
      let best = null;
      for (let yy = y - 1; yy <= y + 1 && yy >= 1; yy++) for (const [t, to] of yearOnsets(yy)) if (t <= ms && (!best || t > best[0])) best = [t, to];
      if (!best) { // before this year's first change: the last change of an earlier year (rules that skip years, or old DTSTARTs)
        for (let yy = y - 2; yy >= y - 30 && !best; yy--) for (const [t, to] of yearOnsets(yy)) if (t <= ms && (!best || t > best[0])) best = [t, to];
      }
      return best ? best[1] : earliest.from;
    },
  };
}

/** The IANA zone that keeps the same clock as `zone` through the year around `at` (preferring `prefer`). */
function matchingIana(zone, at, prefer) {
  const samples = Array.from({ length: 26 }, (_, i) => at - 182 * 864e5 + i * 14 * 864e5);
  const same = (tz) => samples.every((t) => offsetAt(t, tz) === zone.offsetAt(t));
  if (prefer && isIana(prefer) && same(prefer)) return prefer;
  for (const tz of Intl.supportedValuesOf('timeZone')) if (same(tz)) return tz;
  return null;
}

/** Turns a TZID into a zone, given the file's VTIMEZONE definitions (TZID → content lines). */
export function resolveZone(tzid, defs = {}, fallback = 'UTC') {
  const iana = ianaFor(tzid);
  if (iana) return iana;
  const key = String(tzid || '').trim().replace(/^"|"$/g, '');
  const def = defs[key];
  return (def && zoneFromDefinition(def)) || zoneOrUtc(fallback);
}

/** Every VTIMEZONE in a file, by TZID. */
function zoneDefinitions(lines) {
  const defs = {};
  let cur = null, id = null;
  for (const l of lines) {
    if (l.name === 'BEGIN' && /^VTIMEZONE$/i.test(l.value.trim())) { cur = []; id = null; continue; }
    if (cur && l.name === 'END' && /^VTIMEZONE$/i.test(l.value.trim())) { if (id) defs[id] = cur; cur = null; continue; }
    if (!cur) continue;
    if (l.name === 'TZID' && id === null) id = l.value.trim().replace(/^"|"$/g, '');
    else cur.push(l);
  }
  return defs;
}

/** For one file: TZID → zone (cached), and the IANA name to keep with the event. */
function zoneResolver(lines, fallback) {
  const defs = zoneDefinitions(lines);
  const cache = new Map();
  const zones = (tzid) => { if (!cache.has(tzid)) cache.set(tzid, resolveZone(tzid, defs, fallback)); return cache.get(tzid); };
  const ianaOf = (tzid, at) => {
    if (!tzid) return zoneOrUtc(fallback);
    const z = zones(tzid);
    return typeof z === 'string' ? z : matchingIana(z, at, fallback) || zoneOrUtc(fallback);
  };
  return { zones, ianaOf };
}

/**
 * The event in a calendar file, as Workspace stores it, or { error }. Repeat rules Workspace can't
 * show (e.g. "the second Monday of each month") come through as a one-off on the first date.
 */
export function parseIcsEvent(text, { tz = 'UTC', resolver } = {}) {
  const all = contentLines(text);
  const { zones, ianaOf } = resolver || zoneResolver(all, tz);
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
  const startL = get('DTSTART');
  const start = startL && parseWhen(startL, tz, zones);
  if (!start) return { error: 'The event has no valid start' };
  let end;
  const endL = get('DTEND'), durL = get('DURATION');
  if (endL) end = parseWhen(endL, tz, zones);
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
    start: start.ms, end: endMs, all_day: allDay ? 1 : 0, tz: allDay ? tz : ianaOf(startL.params.TZID, start.ms), rrule: null, exdates: [],
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
        for (const v of l.value.split(',')) { const w = parseWhen({ value: v, params: l.params }, out.tz, zones); if (w) out.exdates.push(w.ms); }
      }
    }
  }
  // Reminders set on the phone: the main event's VALARMs.
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const mainRaw = (unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || []).find((b) => !/\nRECURRENCE-ID[;:]/i.test(b));
  out.reminders = mainRaw ? alarmsIn(mainRaw, start.ms) : [];
  // Occurrences changed on their own (or cancelled) in the same file.
  out.overrides = [];
  for (const raw of String(text || '').replace(/\r?\n[ \t]/g, '').match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || []) {
    const ridLine = contentLines(raw).find((l) => l.name === 'RECURRENCE-ID');
    if (!ridLine) continue;
    const rid = parseWhen(ridLine, out.tz, zones);
    if (!rid) continue;
    const cancelled = /\nSTATUS:CANCELLED/i.test(raw);
    const body = raw.split(/\r?\n/).filter((l) => !/^(RECURRENCE-ID|RRULE|EXDATE)[;:]/i.test(l)).join('\r\n');
    const o = parseIcsEvent(`BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR`, { tz: out.tz, resolver: { zones, ianaOf } });
    if (o.error) continue;
    out.overrides.push({ recurrenceId: rid.ms, cancelled, title: o.title, location: o.location, description: o.description, start: o.start, end: o.end, all_day: o.all_day });
  }
  return out;
}
