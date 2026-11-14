// Quick add (Calendar): "Lunch with Kim fri 1pm for 30m" becomes an event called "Lunch with Kim",
// Friday 13:00–13:30. Days, times and repeats are read as Tasks' quick add reads them; on top of that
// a time range ("3-4pm", "10:30 to 11:15", "from 9 to 11am") and a length ("for 45 minutes",
// "for 2 hours", "for an hour") set the end. A day without a time is an all-day event. "@kim" or "@Kim Park"
// (a colleague) and email addresses become guests; the colleague's name stays in the title. "in the
// Boardroom" or "at Lisbon" (one of the company's rooms) picks that room.
import { parseQuickAdd } from '../tasks/quickadd.js';
import { readCustom } from '../tasks/taskmath.js';

const DAY = 864e5;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** "1", "30", "pm" → minutes after midnight, or null. Without am/pm, 1–7 o'clock count as afternoon only if `pmHint`. */
function clock(h, m, ap, pmHint) {
  let hh = Number(h);
  const mm = Number(m || 0);
  if (mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (/p/i.test(ap) && hh !== 12) hh += 12;
    if (/a/i.test(ap) && hh === 12) hh = 0;
  } else {
    if (hh > 23) return null;
    if (pmHint && hh < 12) hh += 12;
  }
  return hh * 60 + mm;
}

/** A tasks repeat ("weekly", "every:2:week:1,3") as the calendar's rule, for an event starting at `start`. */
export function ruleFromRepeat(repeat, start) {
  if (!repeat) return null;
  const dow = new Date(start).getDay();
  if (repeat === 'weekdays') return { freq: 'weekly', byday: [1, 2, 3, 4, 5] };
  const plain = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' }[repeat];
  if (plain) return plain === 'weekly' ? { freq: 'weekly', byday: [dow] } : { freq: plain };
  const c = readCustom(repeat);
  if (!c) return null;
  const out = { freq: { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[c.unit] };
  if (c.n > 1) out.interval = c.n;
  if (out.freq === 'weekly') out.byday = c.days.length ? c.days : [dow];
  return out;
}

const EMAIL = /(?<=^|[\s,(<])([a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?=$|[\s,)>])/i;

/**
 * Guests in a line: "@kim", "@Kim Park" (from `people`: [{ name, username }]) and email addresses.
 * Returns { text, guests: [email], names: [name] }: a colleague's "@…" becomes their name; an address is
 * taken out (with a "with" or "and" left dangling before it). An "@word" matching nobody stays as typed.
 */
export function guestsIn(input, people = [], { drop = false } = {}) { // drop: a colleague's "@…" is taken out too (marked, for tidy)
  let s = ` ${input} `;
  const guests = [];
  const names = [];
  const add = (email, name) => { const e = email.toLowerCase(); if (!guests.includes(e)) { guests.push(e); if (name) names.push(name); } };
  const first = (p) => p.name?.toLowerCase().split(/\s+/)[0];
  s = s.replace(/(^|[\s,(])@([\p{L}][\p{L}.'-]*)(?:\s+([\p{L}][\p{L}'-]*))?(?=$|[\s,.;:!?)])/gu, (all, pre, a, b) => {
    const full = b && people.find((p) => p.name?.toLowerCase() === `${a} ${b}`.toLowerCase());
    if (full) { add(full.username, full.name); return `${pre}${drop ? ' \u2043 ' : full.name}`; }
    const w = a.toLowerCase();
    const matches = people.filter((p) => first(p) === w || p.username?.toLowerCase().split('@')[0] === w || p.name?.toLowerCase() === w);
    if (matches.length !== 1) return all; // nobody, or more than one Kim: as typed
    add(matches[0].username, matches[0].name);
    return `${pre}${drop ? ' \u2043 ' : matches[0].name.split(/\s+/)[0]}${b ? ` ${b}` : ''}`;
  });
  for (let m; (m = EMAIL.exec(s));) {
    add(m[1]);
    s = `${s.slice(0, m.index)} \u2043 ${s.slice(m.index + m[0].length)}`; // a mark where it was, tidied once dates are out
  }
  return { text: s.replace(/\s+/g, ' ').trim(), guests, names };
}

/** Where addresses were taken out: drop the marks, with a "with", "and" or comma left hanging before them. */
export function tidy(title) {
  let t = ` ${title} `;
  for (let i = 0; i < 20 && t.includes('\u2043'); i++) t = t.replace(/(?:\s*(?:,|\band\b|&|\bwith\b))*\s*\u2043\s*/i, ' ');
  return t.replace(/\(\s*\)/g, '').replace(/\s+([,.])/g, '$1').replace(/[\s,]+$/, '').replace(/\s+/g, ' ').trim();
}

const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Rooms in a line: "in Boardroom", "at the Lisbon room", "in Room 2" (names from `rooms`: [{ id, name }], longest
 * first so "Room 12" isn't read as "Room 1"). Returns { text, ids }, the words naming them taken out.
 */
export function roomsIn(input, rooms = []) {
  let s = ` ${input} `;
  const ids = [];
  for (const r of [...rooms].filter((x) => x.name?.trim()).sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`\\s(?:in|at)\\s+(?:the\\s+)?${escape(r.name.trim()).replace(/\s+/g, '\\s+')}(?:\\s+room)?(?=[\\s,.)]|$)`, 'iu');
    const m = re.exec(s);
    if (!m || ids.includes(r.id)) continue;
    ids.push(r.id);
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  }
  return { text: s.replace(/\s+/g, ' ').trim(), ids };
}

/**
 * What a quick-add line makes: { title, start, end, all_day, rrule, guests, rooms, found } (ms, local time), or null
 * when it names no day or time. `today` is "YYYY-MM-DD"; `minutes` the length when none is said; `people` who
 * "@name" can be; `rooms` the company's rooms.
 */
export function parseQuickEvent(input, { today, minutes = 60, people = [], rooms = [] } = {}) {
  const where = roomsIn(String(input || '').trim(), rooms);
  const who = guestsIn(where.text, people);
  let s = ` ${who.text} `;
  let length = null;
  let range = null; // [startMinutes, endMinutes]
  // A length: "for 45 minutes", "for 1.5 hours", "for an hour", "for half an hour".
  const len = /\sfor\s+(?:(\d{1,3}(?:\.\d)?)\s*(m|mins?|minutes?|h|hrs?|hours?)|(an?|one)\s+hour|half\s+an\s+hour)(?=[\s,.]|$)/i.exec(s);
  if (len) {
    length = len[1] ? Math.round(Number(len[1]) * (/^h/i.test(len[2]) ? 60 : 1)) : /half/i.test(len[0]) ? 30 : 60;
    if (length < 1 || length > 24 * 60) length = null;
    else s = `${s.slice(0, len.index)} ${s.slice(len.index + len[0].length)}`;
  }
  // A range: "3-4pm", "3pm-4:30pm", "10:30 to 11:15", "from 9 to 11am", "9am–noon" isn't (say 12pm).
  const r = /\s(?:from\s+|at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?(?=[\s,.]|$)/i.exec(s);
  if (r && (r[2] || r[3] || r[5] || r[6])) { // "2-3" alone could be anything ("2-3 people"): needs a colon or am/pm
    const end = clock(r[4], r[5], r[6], false);
    // "3-4pm": the start takes the end's half of the day, unless that would put it after the end ("11-1pm").
    let st = clock(r[1], r[2], r[3] || r[6], false);
    if (!r[3] && r[6] && st !== null && end !== null && st > end) st = clock(r[1], r[2], 'am', false);
    if (st !== null && end !== null && end > st) {
      range = [st, end];
      s = `${s.slice(0, r.index)} ${s.slice(r.index + r[0].length)}`;
    }
  }
  // A placeholder word, so a line that is only a day and time ("tomorrow 3pm") isn't kept as typed.
  const q = parseQuickAdd(`${s} \u2042 `, { today, datesOnly: true });
  q.title = tidy(q.title.replace(/\s*\u2042\s*/, ' '));
  const day = q.due || (range ? today : null);
  if (!day) return null;
  const found = [];
  const base = fromIso(day).getTime();
  const at = (mins) => { const d = fromIso(day); d.setHours(0, mins, 0, 0); return d.getTime(); };
  let start; let end; let allDay = 0;
  if (range) { start = at(range[0]); end = at(range[1]); }
  else if (q.due_time) {
    const [h, m] = q.due_time.split(':').map(Number);
    start = at(h * 60 + m);
    end = start + (length ?? minutes) * 60e3;
  } else if (length) { start = at(9 * 60); end = start + length * 60e3; } // a day and a length: from 9:00
  else { allDay = 1; start = base; end = base + DAY - 1; }
  found.push({ kind: 'when', start, end, all_day: allDay });
  const rrule = ruleFromRepeat(q.repeat, start);
  if (rrule) found.push({ kind: 'repeat', rule: rrule });
  if (who.guests.length) found.push({ kind: 'guests', emails: who.guests });
  if (where.ids.length) found.push({ kind: 'rooms', ids: where.ids });
  return { title: q.title, start, end, all_day: allDay, rrule, guests: who.guests, rooms: where.ids, found };
}
