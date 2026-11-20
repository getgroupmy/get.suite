// Repeating events against python-dateutil's RFC 5545 rules: the dates the calendar shows, the RRULE written for
// phones and invitations, and rules read from them must all be the same dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { occurrenceStarts } from '../src/calmath.js';
import { buildIcs, parseIcsEvent } from '../src/ics.js';

const hasDateutil = spawnSync('python3', ['-c', 'import dateutil.rrule, zoneinfo'], { stdio: 'ignore' }).status === 0;
const local = (ms, tz) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(' ', 'T');
const D = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const vevent = (lines) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\n${lines.join('\r\n')}\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

// dateutil's dates for each { ics, tz, to }: the DTSTART and RRULE inside the VEVENT, as local wall-clock times.
const PY = `import json, sys, re
from datetime import datetime
from zoneinfo import ZoneInfo
from dateutil.rrule import rrulestr
out = []
for c in json.load(sys.stdin):
    ev = c['ics'].replace('\\r\\n ', '').split('\\r\\n'); ev = ev[ev.index('BEGIN:VEVENT'):]
    ds = [l for l in ev if l.startswith('DTSTART')][0]; rr = [l for l in ev if l.startswith('RRULE:')][0]
    tz = ZoneInfo(c['tz']); UTC = ZoneInfo('UTC')
    if ds.startswith('DTSTART;VALUE=DATE:'):  # all day: dates
        start = datetime.strptime(ds[19:27], '%Y%m%d'); end = datetime.strptime(c['to'][:10], '%Y-%m-%d')
        got = []
        for o in rrulestr(rr[6:], dtstart=start):
            if o >= end or len(got) > 2000: break
            got.append(o.strftime('%Y-%m-%d'))
        out.append(got); continue
    m = re.match(r'DTSTART;TZID=([^:]+):(\\d{8}T\\d{6})', ds)
    start = datetime.strptime(m.group(2), '%Y%m%dT%H%M%S').replace(tzinfo=ZoneInfo(m.group(1))) if m else datetime.strptime(ds[8:23], '%Y%m%dT%H%M%S').replace(tzinfo=UTC)
    end = datetime.strptime(c['to'], '%Y-%m-%dT%H:%M').replace(tzinfo=tz)
    got = []
    for o in rrulestr(rr[6:], dtstart=start):
        if o >= end or len(got) > 2000: break
        got.append(o.astimezone(UTC).astimezone(tz).strftime('%Y-%m-%dT%H:%M'))  # (a time the clocks skip: moved on)
    out.append(got)
print(json.dumps(out))`;
const dateutil = (cases) => JSON.parse(execFileSync('python3', ['-c', PY], { input: JSON.stringify(cases), encoding: 'utf8' }));

function randomEvents(seed, n, allDay = false) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = [];
  for (let k = 0; k < n; k++) {
    const tz = pick(['Europe/London', 'America/New_York', 'Asia/Kuala_Lumpur', 'Australia/Sydney']);
    const mo = Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28), h = pick([0, 1, 2, 9, 23]), mi = pick([0, 30]);
    const [hh, mm] = allDay ? [0, 0] : [h, mi]; // all day: midnight there
    let start = Date.UTC(2026, mo, d, hh, mm); // that wall-clock time in tz
    for (let i = 0; i < 3; i++) { const [ly, lm, ld, lh, lmi] = local(start, tz).split(/[-T:]/).map(Number); start += Date.UTC(2026, mo, d, hh, mm) - Date.UTC(ly, lm - 1, ld, lh, lmi); }
    const freq = pick(['daily', 'weekly', 'weekly', 'monthly', 'monthly', 'monthly', 'yearly']);
    const r = { freq, interval: pick([1, 1, 2, 3]) };
    if (freq === 'weekly' && rnd() < 0.7) r.byday = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 7)))].sort();
    if (r.byday && r.interval > 1 && rnd() < 0.5) r.wkst = pick([1, 1, 3, 6]);
    if (freq === 'monthly') { const v = rnd(); if (v < 0.3) { r.nth = pick([1, 2, 3, 4, 5, -1]); r.wd = Math.floor(rnd() * 7); } else if (v < 0.5) { r.nths = [1, 3]; r.wd = Math.floor(rnd() * 7); } else if (v < 0.65) { r.setpos = pick([1, 2, -1, -1]); r.setdays = pick([[1, 2, 3, 4, 5], [0, 6], [1, 3, 5]]); } }
    if (rnd() < 0.5) r.count = 1 + Math.floor(rnd() * 15); else if (0.5 > rnd()) r.until = start + Math.floor(rnd() * 400) * 864e5;
    if (allDay && r.until !== undefined) r.until += 864e5 - 1; // to the end of that day, as the editor saves it
    out.push(allDay ? { start, end: start + 864e5 - 1, all_day: 1, title: 'x', tz, rrule: r } : { start, end: start + 36e5, all_day: 0, title: 'x', tz, rrule: r });
  }
  return out;
}

test('the RRULE written for an event gives the dates the calendar shows (every other month, weeks, clock changes)', { skip: !hasDateutil && 'python-dateutil isn’t installed here' }, () => {
  const events = randomEvents(7, 300);
  const cases = events.map((ev) => { const to = ev.start + 800 * 864e5; return { tz: ev.tz, to: local(to, ev.tz), ics: buildIcs(ev, { uid: 'u', tz: ev.tz, now: 0 }), ours: occurrenceStarts(ev, to).map((t) => local(t, ev.tz)) }; });
  const theirs = dateutil(cases);
  const bad = cases.map((c, i) => ({ c, i })).filter(({ c, i }) => JSON.stringify(c.ours) !== JSON.stringify(theirs[i]));
  assert.equal(bad.length, 0, bad.slice(0, 3).map(({ c, i }) => { const k = c.ours.findIndex((x, j) => x !== theirs[i][j]); return `${JSON.stringify(events[i].rrule)} in ${c.tz}: from #${k} ours ${c.ours.slice(k, k + 3)} (${c.ours.length}), dateutil ${theirs[i].slice(k, k + 3)} (${theirs[i].length})`; }).join('\n'));
  // ...and read back, the rule gives them again
  for (const c of cases) {
    const back = parseIcsEvent(c.ics, { tz: c.tz });
    assert.deepEqual(occurrenceStarts(back, Date.parse(`${c.to}Z`) + 2 * 864e5).map((t) => local(t, c.tz)).filter((x) => x < c.to), c.ours);
  }
});

test('all-day repeats: the file\'s dates are the days the calendar shows, in the person\'s own zone', { skip: !hasDateutil && 'python-dateutil isn’t installed here' }, () => {
  // The browser shows an all-day event from midnight in its own zone; the server writing the file may be on another clock.
  const events = randomEvents(31, 200, true);
  const cases = events.map((ev) => {
    const to = ev.start + 800 * 864e5;
    return { tz: ev.tz, to: local(to, ev.tz), ics: buildIcs(ev, { uid: 'u', tz: ev.tz, now: 0 }), ours: occurrenceStarts({ ...ev, all_day: 0 }, to).map((t) => local(t, ev.tz).slice(0, 10)).filter((x) => x < local(to, ev.tz).slice(0, 10)) };
  });
  const theirs = dateutil(cases);
  const bad = cases.map((c, i) => ({ c, i })).filter(({ c, i }) => JSON.stringify(c.ours) !== JSON.stringify(theirs[i]));
  assert.equal(bad.length, 0, bad.slice(0, 3).map(({ c, i }) => { const k = c.ours.findIndex((x, j) => x !== theirs[i][j]); return `${JSON.stringify(events[i].rrule)} in ${c.tz}: from #${k} ours ${c.ours.slice(k, k + 3)} (${c.ours.length}), dateutil ${theirs[i].slice(k, k + 3)} (${theirs[i].length})`; }).join('\n'));
});

test('weekly rules from phones and Outlook (with or without WKST) give dateutil\'s dates', { skip: !hasDateutil && 'python-dateutil isn’t installed here' }, () => {
  let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let k = 0; k < 200; k++) {
    const dt = `2026${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}T100000Z`;
    const days = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(D)))];
    const wk = pick(['', '', 'MO', 'SU', 'WE', 'SA']);
    const ics = vevent([`DTSTART:${dt}`, `DTEND:${dt}`, `RRULE:FREQ=WEEKLY;INTERVAL=${pick([2, 3])};BYDAY=${days.join(',')}${wk ? `;WKST=${wk}` : ''};COUNT=${5 + Math.floor(rnd() * 10)}`]);
    const ev = parseIcsEvent(ics, { tz: 'UTC' });
    cases.push({ ics, tz: 'UTC', to: '2030-01-01T00:00', ours: occurrenceStarts({ ...ev, tz: 'UTC' }, Infinity).map((t) => local(t, 'UTC')) });
  }
  const theirs = dateutil(cases);
  const bad = cases.filter((c, i) => JSON.stringify(c.ours) !== JSON.stringify(theirs[i]));
  assert.equal(bad.length, 0, bad.slice(0, 3).map((c) => c.ics.match(/RRULE:.*/)[0]).join('\n'));
});

test('the first or last weekday of the month, as Outlook writes it (BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1), read as dateutil reads it', { skip: !hasDateutil && 'python-dateutil isn’t installed here' }, () => {
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let k = 0; k < 150; k++) {
    const dt = `2026${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}T090000Z`;
    const rule = `FREQ=MONTHLY${pick(['', ';INTERVAL=2', ';INTERVAL=3'])};BYDAY=${pick(['MO,TU,WE,TH,FR', 'SA,SU', 'MO,WE,FR'])};BYSETPOS=${pick(['1', '2', '-1', '-1'])};COUNT=${3 + Math.floor(rnd() * 10)}`;
    const ics = vevent([`DTSTART:${dt}`, `DTEND:${dt}`, `RRULE:${rule}`]);
    const ev = parseIcsEvent(ics, { tz: 'UTC' });
    assert.ok(ev.rrule?.setpos, `read as a repeat: ${rule}`);
    cases.push({ ics, tz: 'UTC', to: '2032-01-01T00:00', ours: occurrenceStarts({ ...ev, tz: 'UTC' }, Infinity).map((t) => local(t, 'UTC')) });
  }
  const theirs = dateutil(cases);
  const bad = cases.filter((c, i) => JSON.stringify(c.ours) !== JSON.stringify(theirs[i]));
  assert.equal(bad.length, 0, bad.slice(0, 3).map((c, i) => `${c.ics.match(/DTSTART:.*|RRULE:.*/g).join(' ')}: ours ${c.ours.slice(0, 3)}`).join('\n'));
});

test('weeks that start on Monday: every other Sunday and Monday is a Sunday, then the next week\'s Monday', () => {
  // RFC 5545 counts weeks from Monday unless WKST says, so Sunday 6 Dec ends a week and Monday 7 Dec starts the skipped one.
  const ev = parseIcsEvent(vevent(['DTSTART:20261206T100000Z', 'DTEND:20261206T110000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;COUNT=4']), { tz: 'UTC' });
  assert.deepEqual(ev.rrule, { freq: 'weekly', interval: 2, byday: [0, 1], count: 4, wkst: 1 });
  assert.deepEqual(occurrenceStarts({ ...ev, tz: 'UTC' }, Infinity).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-12-06', '2026-12-14', '2026-12-20', '2026-12-28']);
  const sundayWeeks = parseIcsEvent(vevent(['DTSTART:20261206T100000Z', 'DTEND:20261206T110000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=4']), { tz: 'UTC' });
  assert.equal(sundayWeeks.rrule.wkst, undefined);
  assert.deepEqual(occurrenceStarts({ ...sundayWeeks, tz: 'UTC' }, Infinity).map((t) => new Date(t).toISOString().slice(0, 10)), ['2026-12-06', '2026-12-07', '2026-12-20', '2026-12-21']);
  // written out again, with the week start it was read with
  assert.match(buildIcs({ ...ev, title: 'x' }, { uid: 'u', tz: 'Europe/London', now: 0 }), /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO;COUNT=4/);
  assert.match(buildIcs({ ...sundayWeeks, title: 'x' }, { uid: 'u', tz: 'Europe/London', now: 0 }), /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=4/);
});

test('every other month from a day after that month\'s one: DTSTART is the first real one, and the months count from the start', () => {
  // Starts Saturday 26 Sep (New York), the third Tuesday every 2 months: September's (the 15th) was before it, so the
  // first is in November, then January. Written as DTSTART 20 Oct, the months would count from October instead.
  const start = Date.UTC(2026, 8, 26, 4, 30);
  const ev = { start, end: start + 36e5, all_day: 0, title: 'x', tz: 'America/New_York', rrule: { freq: 'monthly', interval: 2, nth: 3, wd: 2, count: 3 } };
  assert.deepEqual(occurrenceStarts(ev, Infinity).map((t) => local(t, ev.tz)), ['2026-11-17T00:30', '2027-01-19T00:30', '2027-03-16T00:30']);
  assert.match(buildIcs(ev, { uid: 'u', tz: ev.tz, now: 0 }), /DTSTART;TZID=America\/New_York:20261117T003000/);
});

test('a time the clocks skip comes an hour later, not an hour early', () => {
  // Daily at 2:30 in New York: on 14 Mar 2027 the clocks go from 2:00 to 3:00, so that day's is at 3:30 (RFC 5545).
  const start = Date.UTC(2027, 2, 13, 7, 30); // 13 Mar, 2:30 EST
  const [, skipped, next] = occurrenceStarts({ start, end: start + 36e5, all_day: 0, tz: 'America/New_York', rrule: { freq: 'daily', count: 3 } }, Infinity);
  assert.deepEqual([local(skipped, 'America/New_York'), local(next, 'America/New_York')], ['2027-03-14T03:30', '2027-03-15T02:30']);
});
