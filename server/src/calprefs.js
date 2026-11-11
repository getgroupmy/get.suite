// Calendar settings, kept per person: how long a new event is, speedy meetings (they end a little early,
// to leave a gap before the next one), and the reminders a new event starts with.
export const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
export const DEFAULT_CAL_PREFS = { length: 60, speedy: false, reminders: [10], declined: true, colorRules: [] }; // declined: show invitations you said No to (faded)

/** Settings as stored: a length offered, speedy on or off, and up to 5 reminders (0 to 4 weeks before, no repeats). */
export function cleanCalPrefs(p) {
  const length = LENGTHS.includes(Number(p?.length)) ? Number(p.length) : DEFAULT_CAL_PREFS.length;
  const reminders = Array.isArray(p?.reminders)
    ? [...new Set(p.reminders.map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 40320))].sort((a, b) => a - b).slice(0, 5)
    : DEFAULT_CAL_PREFS.reminders;
  return { length, speedy: !!p?.speedy, reminders, declined: p?.declined !== false, colorRules: colorRulesOf(p?.colorRules) };
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
