// Calendar settings, kept per person: how long a new event is, speedy meetings (they end a little early,
// to leave a gap before the next one), and the reminders a new event starts with.
export const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
export const DEFAULT_CAL_PREFS = { length: 60, speedy: false, reminders: [10], declined: true }; // declined: show invitations you said No to (faded)

/** Settings as stored: a length offered, speedy on or off, and up to 5 reminders (0 to 4 weeks before, no repeats). */
export function cleanCalPrefs(p) {
  const length = LENGTHS.includes(Number(p?.length)) ? Number(p.length) : DEFAULT_CAL_PREFS.length;
  const reminders = Array.isArray(p?.reminders)
    ? [...new Set(p.reminders.map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 40320))].sort((a, b) => a - b).slice(0, 5)
    : DEFAULT_CAL_PREFS.reminders;
  return { length, speedy: !!p?.speedy, reminders, declined: p?.declined !== false };
}

/** How many minutes a new event lasts: the length, less 5 (under an hour) or 10 minutes with speedy meetings. */
export const newEventMinutes = ({ length, speedy }) => (speedy && length >= 30 ? length - (length >= 60 ? 10 : 5) : length);
