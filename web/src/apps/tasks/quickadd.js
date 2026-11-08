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
export function parseQuickAdd(input, { today, people = [] } = {}) {
  let s = ` ${String(input || '')} `;
  const out = { due: null, due_time: null, repeat: null, important: false, assignee_id: null, found: [] };
  const take = (re, fn) => {
    const m = re.exec(s);
    if (!m) return false;
    const r = fn(m);
    if (r === false) return false;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return true;
  };

  take(/\s!(?:important)?(?=\s)/i, () => { out.important = true; out.found.push({ kind: 'important', text: 'Important' }); });
  for (const [re, v] of REPEAT_WORDS) if (take(re, () => { out.repeat = v; })) break;

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

  // A time or a repeat needs a day: today.
  if (!out.due && (out.due_time || out.repeat)) out.due = today;
  if (out.due) out.found.unshift({ kind: 'due', text: out.due });
  if (out.due_time) out.found.splice(1, 0, { kind: 'time', text: out.due_time });
  if (out.repeat) out.found.push({ kind: 'repeat', text: out.repeat });
  out.title = s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,.-]+|[\s,-]+$/g, '').trim();
  // Nothing left to call it: keep the text as it was.
  if (!out.title) return { title: String(input || '').trim(), due: null, due_time: null, repeat: null, important: false, assignee_id: null, found: [] };
  return out;
}
