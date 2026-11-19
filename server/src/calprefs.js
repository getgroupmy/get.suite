// Calendar settings, kept per person: how long a new event is, speedy meetings (they end a little early,
// to leave a gap before the next one), and the reminders a new event starts with.
export const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
export const DEFAULT_CAL_PREFS = { length: 60, speedy: false, reminders: [10], declined: true, colorRules: [], nextMeeting: true, focusGoal: 0, emailReminders: false, weekStart: null, weekends: null, weekNumbers: null, others: null, showTasks: null, showBirthdays: null }; // others: colleagues' and rooms' busy times shown beside yours, [{ id, name, color, room? }]; showTasks, showBirthdays: on the calendar; // weekStart (0 Sunday, 1 Monday, 6 Saturday), weekends, weekNumbers: how the views look (null: not chosen yet, the browser's earlier choice or the usual); emailReminders: event reminders by email too // focusGoal: hours of focus time a week to aim for (0: none); declined: show invitations you said No to (faded); nextMeeting: in the top bar

/** Settings as stored: a length offered, speedy on or off, and up to 5 reminders (0 to 4 weeks before, no repeats). */
export function cleanCalPrefs(p) {
  const length = LENGTHS.includes(Number(p?.length)) ? Number(p.length) : DEFAULT_CAL_PREFS.length;
  const reminders = Array.isArray(p?.reminders)
    ? [...new Set(p.reminders.map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 40320))].sort((a, b) => a - b).slice(0, 5)
    : DEFAULT_CAL_PREFS.reminders;
  return { length, speedy: !!p?.speedy, reminders, declined: p?.declined !== false, colorRules: colorRulesOf(p?.colorRules), nextMeeting: p?.nextMeeting !== false, focusGoal: Number.isInteger(Number(p?.focusGoal)) && Number(p.focusGoal) >= 1 && Number(p.focusGoal) <= 60 ? Number(p.focusGoal) : 0, emailReminders: p?.emailReminders === true,
    weekStart: [0, 1, 6].includes(p?.weekStart) ? p.weekStart : null, weekends: typeof p?.weekends === 'boolean' ? p.weekends : null, weekNumbers: typeof p?.weekNumbers === 'boolean' ? p.weekNumbers : null,
    others: othersOf(p?.others), showTasks: typeof p?.showTasks === 'boolean' ? p.showTasks : null, showBirthdays: typeof p?.showBirthdays === 'boolean' ? p.showBirthdays : null };
}

/** Colleagues and rooms whose busy times show beside yours: at most 10, each { id, name, color, room? } (null: not chosen yet). */
function othersOf(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const o of list) {
    const id = String(o?.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id) || out.some((x) => x.id === id)) continue;
    out.push({ id, name: String(o?.name ?? '').slice(0, 100), color: /^#[0-9a-f]{6}$/i.test(String(o?.color ?? '')) ? String(o.color).toLowerCase() : '#8430ce', ...(o?.room && { room: true }) });
  }
  return out.slice(-10);
}

export const MAX_COLOR_RULES = 20;
/**
 * Colours by what an event is called: [{ word, color }] — events (yours, invitations, shared calendars')
 * whose title has the word or phrase, and no colour of their own, show in that colour, for you alone.
 * `strict` refuses bad ones (when saving); otherwise they're left out.
 */
export function colorRulesOf(list, { strict = false } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { if (strict) throw new Error('Colour rules must be a list'); return []; }
  const out = [];
  for (const r of list) {
    const word = String(r?.word ?? '').trim().replace(/\s+/g, ' ');
    const color = String(r?.color ?? '').toLowerCase();
    const ok = word.length >= 1 && word.length <= 40 && /^#[0-9a-f]{6}$/.test(color);
    if (!ok) { if (strict) throw new Error(word ? `“${word.slice(0, 40)}” needs a colour (#rrggbb) and at most 40 characters` : 'Each rule needs a word'); continue; }
    if (out.some((x) => x.word.toLowerCase() === word.toLowerCase())) continue;
    out.push({ word, color });
  }
  if (out.length > MAX_COLOR_RULES) { if (strict) throw new Error(`At most ${MAX_COLOR_RULES} colour rules`); return out.slice(0, MAX_COLOR_RULES); }
  return out;
}

/** How many minutes a new event lasts: the length, less 5 (under an hour) or 10 minutes with speedy meetings. */
export const newEventMinutes = ({ length, speedy }) => (speedy && length >= 30 ? length - (length >= 60 ? 10 : 5) : length);
