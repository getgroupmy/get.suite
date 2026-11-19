// Quick add (Tasks): read a due date, a time, a repeat, "!" for important and "@name" for who it's
// for out of what's typed in "Add a task", so "Send invoice tomorrow 3pm every month !" becomes the
// task "Send invoice", due tomorrow at 15:00, repeating monthly, starred. What's understood is
// removed from the title; the rest stays as typed.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PREP = '(?:(?:on|by|due|for)\\s+)?';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); };
const valid = (y, m, d) => { const x = new Date(y, m - 1, d); return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d; };

/** The next date (after today) that falls on this weekday. */
function nextWeekday(today, dow) {
  const cur = fromIso(today).getDay();
  return addDays(today, ((dow - cur + 7) % 7) || 7);
}

/** A day and month without a year: this year, or next year once it has passed. */
function dayMonth(today, d, m) {
  let y = fromIso(today).getFullYear();
  if (!valid(y, m, d)) return null;
  if (`${y}-${pad(m)}-${pad(d)}` < today) y += 1;
  return valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

import { customRepeat, readCustom, readMonthWeek, monthWeekRepeat } from './taskmath.js';

const DAY_WORDS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_RE = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';
/** "every 2 weeks", "every other month", "every mon and thu", "every 2 weeks on tuesday": a custom repeat, or null. */
function customRepeatIn(s) {
  const m = new RegExp(`\\bevery\\s+(?:(other|\\d{1,2})\\s+)?(day|week|month|year)s?(?:\\s+on\\s+(${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*))?\\b`, 'i').exec(s)
    || new RegExp(`\\bevery\\s+(${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)\\b`, 'i').exec(s);
  if (!m) return null;
  const daysOf = (t) => (t ? t.toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/g).map((d) => DAY_WORDS[d]) : []);
  if (m.length === 2) return { match: m, repeat: customRepeat({ n: 1, unit: 'week', days: daysOf(m[1]) }) }; // "every mon and thu"
  const n = m[1] ? (m[1].toLowerCase() === 'other' ? 2 : Number(m[1])) : 1;
  if (n === 1 && !m[3]) return null; // plain ones: below
  return { match: m, repeat: customRepeat({ n, unit: m[2].toLowerCase(), days: daysOf(m[3]) }) };
}

const REPEAT_WORDS = [
  [/\b(?:every\s+weekday|weekdays|every\s+work\s*day)\b/i, 'weekdays'],
  [/\b(?:every\s+day|daily)\b/i, 'daily'],
  [/\b(?:every\s+week|weekly)\b/i, 'weekly'],
  [/\b(?:every\s+month|monthly)\b/i, 'monthly'],
  [/\b(?:every\s+year|yearly|annually)\b/i, 'yearly'],
];

/**
 * What's in a quick-add line: { title, due, due_time, repeat, important, assignee_id, found }.
 * `found` lists what was understood ({ kind, text }) so the page can show it before adding.
 * `people` ([{ id, name, username }]) are who "@name" can mean; `today` is "YYYY-MM-DD".
 */
const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 };
const WD = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const ORD_WORD = '(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)';
/**
 * Weeks of the month: "every first and third Monday", "on the 2nd and 4th Tue", "the last Friday of the month"
 * → { rule: { freq: 'monthly', nth | nths, wd }, text without it }, or null.
 */
export function monthlyWeekdaysIn(text) {
  const re = new RegExp(`\\s(?:every|each|on)?\\s*(?:the\\s+)?(${ORD_WORD}(?:\\s*(?:,|and|&)\\s*(?:the\\s+)?${ORD_WORD})*)\\s+(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)[a-z]*(?:\\s+(?:of\\s+)?(?:the|each|every)\\s+month)?(?=[\\s,.]|$)`, 'i');
  const m = re.exec(` ${text} `);
  if (!m) return null;
  const nths = [...new Set(m[1].toLowerCase().split(/\s*(?:,|and|&)\s*(?:the\s+)?/).map((w) => ORD[w.trim()]).filter((k) => k !== undefined))]
    .sort((a, b) => (a === -1) - (b === -1) || a - b);
  const wd = WD[m[2].toLowerCase().replace(/^(thu)r?s?$/, '$1').slice(0, m[2].toLowerCase().startsWith('tue') ? 3 : 3)];
  if (!nths.length || wd === undefined) return null;
  const rule = nths.length === 1 ? { freq: 'monthly', nth: nths[0], wd } : { freq: 'monthly', nths, wd };
  const t = ` ${text} `;
  return { rule, text: `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim() };
}

/** The first day on or after `fromIso` (YYYY-MM-DD) that `rule` (monthly on weeks of a weekday) falls on. */
export function firstDayOf(rule, from) {
  const d = fromIso(from);
  const nths = rule.nths || [rule.nth];
  for (let i = 0; i < 400; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (x.getDay() !== rule.wd) continue;
    const nth = Math.ceil(x.getDate() / 7), last = x.getDate() + 7 > new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
    if (nths.includes(nth) || (last && nths.includes(-1))) return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }
  return from;
}

/** "fri 1pm" → "friday 1pm": a short day name right before a time (9am, 9:30, at 9, 2-3pm) is that day. */
export const fullDayNames = (text) => text.replace(/(^|\s)(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?=\s+(?:at\s+\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?|\d{1,2}:[0-5]\d|\d{1,2}\s*(?:am|pm)|\d{1,2}(?::[0-5]\d)?\s*(?:-|–|to)\s*\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)(?:[\s,.]|$))/gi,
  (all, sp, d) => `${sp}${DAYS[SHORT_DAYS[d.toLowerCase()]]}`);

export function parseQuickAdd(input, { today, people = [], datesOnly = false } = {}) {
  let s = ` ${String(input || '')} `;
  // A short day name right before a time is a day ("lunch fri 1pm", "sat at 10:30"), read as the full name
  // (times are taken out first). Elsewhere short names need "on", "by"…: "sat with Kim" stays as it is.
  s = fullDayNames(s);
  const out = { due: null, due_time: null, repeat: null, important: false, priority: null, assignee_id: null, tags: [], found: [] };
  const take = (re, fn) => {
    const m = re.exec(s);
    if (!m) return false;
    const r = fn(m);
    if (r === false) return false;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return true;
  };

  // datesOnly (Calendar's quick add): only days, times and repeats; "#", "!" and "@" stay in the title.
  if (!datesOnly) {
  // Tags: "#client" (a word starting with a letter, so "issue #42" stays as it is).
  while (take(/\s#(\p{L}[\p{L}\p{N}_-]{0,29})(?=[\s,.]|$)/u, (m) => { const t = m[1].toLowerCase(); if (!out.tags.includes(t) && out.tags.length < 10) { out.tags.push(t); out.found.push({ kind: 'tag', text: `#${t}` }); } }));
  // A priority: !high, !medium (or !med), !low (also !p1 to !p3, p1 the highest).
  take(/\s!(high|medium|med|low|p[123])(?=[\s,.]|$)/i, (m) => { const v = { high: 'high', p1: 'high', medium: 'medium', med: 'medium', p2: 'medium', low: 'low', p3: 'low' }[m[1].toLowerCase()]; out.priority = v; out.found.push({ kind: 'priority', text: `${v[0].toUpperCase()}${v.slice(1)} priority` }); });
  take(/\s!(?:important)?(?=\s)/i, () => { out.important = true; out.found.push({ kind: 'important', text: 'Important' }); });
  }
  const custom = customRepeatIn(s);
  // Weeks of the month first: "every first and third Monday", "the last Friday of the month".
  const weeks = monthlyWeekdaysIn(s);
  if (weeks) { s = ` ${weeks.text} `; out.repeat = monthWeekRepeat({ weeks: weeks.rule.nths || [weeks.rule.nth], wd: weeks.rule.wd }); }
  else if (custom) { s = `${s.slice(0, custom.match.index)} ${s.slice(custom.match.index + custom.match[0].length)}`; out.repeat = custom.repeat; }
  else for (const [re, v] of REPEAT_WORDS) if (take(re, () => { out.repeat = v; })) break;

  // A time: "at 3pm", "3:30 pm", "15:00", "at 9".
  take(/\s(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)(?=[\s,.]|$)/i, (m) => {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return false;
    if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
    out.due_time = `${pad(h)}:${m[2] || '00'}`;
  }) || take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=[\s,.]|$)/, (m) => { out.due_time = `${pad(Number(m[1]))}:${m[2]}`; })
    || take(/\sat\s+([01]?\d|2[0-3])(?=[\s,.]|$)/i, (m) => { out.due_time = `${pad(Number(m[1]))}:00`; });

  // A date.
  const dateRules = [
    [new RegExp(`\\s${PREP}(today|tonight|tomorrow|tmrw|tmr)(?=[\\s,.]|$)`, 'i'), (m) => (/^to(day|night)$/i.test(m[1]) ? today : addDays(today, 1))],
    [/\snext\s+week(?=[\s,.]|$)/i, () => nextWeekday(today, 1)],
    [/\sin\s+(\d{1,3})\s+(days?|weeks?)(?=[\s,.]|$)/i, (m) => addDays(today, Number(m[1]) * (/^w/i.test(m[2]) ? 7 : 1))],
    [/\s(?:on\s+|by\s+|due\s+)?(\d{4})-(\d{2})-(\d{2})(?=[\s,.]|$)/, (m) => (valid(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : false)],
    [new RegExp(`\\s${PREP}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?=[\\s,.]|$)`, 'i'), (m) => dayMonth(today, +m[1], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1) || false],
    [new RegExp(`\\s${PREP}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=[\\s,.]|$)`, 'i'), (m) => dayMonth(today, +m[2], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1) || false],
    [/\s(?:on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?=[\s,.]|$)/, (m) => dayMonth(today, +m[1], +m[2]) || false], // day/month
    [new RegExp(`\\s${PREP}(?:next\\s+)?(${DAYS.join('|')})(?=[\\s,.]|$)`, 'i'), (m) => nextWeekday(today, DAYS.indexOf(m[1].toLowerCase()))],
    // Short day names only after "on", "by", "due" or "next" ("sat with Kim" stays as it is).
    [/\s(?:on|by|due|next)\s+(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?=[\s,.]|$)/i, (m) => nextWeekday(today, SHORT_DAYS[m[1].toLowerCase()])],
  ];
  for (const [re, fn] of dateRules) {
    if (take(re, (m) => { const d = fn(m); if (!d) return false; out.due = d; })) break;
  }

  // Who it's for: "@kim" or "@Kim Park" (someone on the list).
  if (datesOnly) people = [];
  const assign = (p) => { out.assignee_id = p.id; out.found.push({ kind: 'person', text: p.name }); };
  take(/\s@([\p{L}][\p{L}.'-]*)\s+([\p{L}][\p{L}'-]*)(?=[\s,.]|$)/u, (m) => {
    const p = people.find((x) => x.name?.toLowerCase() === `${m[1]} ${m[2]}`.toLowerCase());
    if (!p) return false;
    assign(p);
  }) || take(/\s@([\p{L}][\p{L}.'-]*)(?=[\s,.]|$)/u, (m) => {
    const w = m[1].toLowerCase();
    const p = people.find((x) => x.name?.toLowerCase().split(/\s+/)[0] === w || x.username?.toLowerCase().split('@')[0] === w || x.name?.toLowerCase() === w);
    if (!p) return false;
    assign(p);
  });

  // Weeks of the month start on the first such day from today (or from the day given).
  const mw = readMonthWeek(out.repeat);
  if (mw && today) out.due = firstDayOf({ nths: mw.weeks, wd: mw.wd }, out.due || today);
  // A repeat on chosen weekdays starts on the first of them from today; a time or another repeat needs a day: today.
  const onDays = readCustom(out.repeat)?.days;
  if (!out.due && onDays?.length && today) {
    const d = new Date(`${today}T00:00:00Z`);
    while (!onDays.includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    out.due = d.toISOString().slice(0, 10);
  }
  if (!out.due && (out.due_time || out.repeat)) out.due = today;
  if (out.due) out.found.unshift({ kind: 'due', text: out.due });
  if (out.due_time) out.found.splice(1, 0, { kind: 'time', text: out.due_time });
  if (out.repeat) out.found.push({ kind: 'repeat', text: out.repeat });
  out.title = s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,.-]+|[\s,-]+$/g, '').trim();
  // Nothing left to call it: keep the text as it was.
  if (!out.title) return { title: String(input || '').trim(), due: null, due_time: null, repeat: null, important: false, priority: null, assignee_id: null, tags: [], found: [] };
  return out;
}
