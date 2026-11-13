// Quick add (Calendar): "Lunch with Kim fri 1pm for 30m" becomes an event called "Lunch with Kim",
// Friday 13:00–13:30. Days, times and repeats are read as Tasks' quick add reads them; on top of that
// a time range ("3-4pm", "10:30 to 11:15", "from 9 to 11am") and a length ("for 45 minutes",
// "for 2 hours", "for an hour") set the end. A day without a time is an all-day event.
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

/**
 * What a quick-add line makes: { title, start, end, all_day, rrule, found } (ms, local time), or null when
 * it names no day or time. `today` is "YYYY-MM-DD"; `minutes` the length when none is said.
 */
export function parseQuickEvent(input, { today, minutes = 60 } = {}) {
  let s = ` ${String(input || '').trim()} `;
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
  q.title = q.title.replace(/\s*\u2042\s*/, ' ').trim();
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
  return { title: q.title, start, end, all_day: allDay, rrule, found };
}
