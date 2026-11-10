// The Birthdays and dates card on Home: your contacts' birthdays and other dates coming up, said plainly.

const DAY = 864e5;
const ms = (d) => Date.parse(`${d}T00:00:00Z`);
/** YYYY-MM-DD a number of days after another. */
export const addDays = (d, n) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);

/** When it is, from today: Today, Tomorrow, the weekday within a week, else "Mon 23 Nov". */
export function whenText(date, today) {
  const n = Math.round((ms(date) - ms(today)) / DAY);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  const d = new Date(ms(date));
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  if (n > 1 && n < 7) return d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return `${wd} ${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/** What it is: "Birthday (36)", "Birthday", "Anniversary (5 years)". */
export function whatText(b) {
  if (b.label) return `${b.label}${b.years ? ` (${b.years} year${b.years === 1 ? '' : 's'})` : ''}`;
  return `Birthday${b.age ? ` (${b.age})` : ''}`;
}

/** The card's lines: from today on, soonest first, each { key, when, what, today, ... }. */
export function upcoming(list, today) {
  return (list || []).filter((b) => b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .map((b) => ({ ...b, key: `${b.contact_id}:${b.date}:${b.label || ''}`, when: whenText(b.date, today), what: whatText(b), today: b.date === today }));
}
