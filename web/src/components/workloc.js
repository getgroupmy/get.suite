// Working location: how a place reads and looks wherever it's shown.
export const PLACES = [['office', '🏢', 'Office'], ['home', '🏠', 'Home'], ['other', '📍', 'Elsewhere']];
const BY = Object.fromEntries(PLACES.map(([k, icon, label]) => [k, { icon, label }]));

/** "🏢 Office", "🏠 Home", "📍 Client site" (a label wins for "elsewhere"). */
export function placeText(p) {
  if (!p?.place || !BY[p.place]) return '';
  return `${BY[p.place].icon} ${p.place === 'other' && p.label ? p.label : BY[p.place].label}`;
}

/** A Date as YYYY-MM-DD in local time. */
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Today and the next working days (Monday to Friday), n days in all: for planning office days. */
export function comingDays(n = 5, from = new Date()) {
  const out = [new Date(from.getFullYear(), from.getMonth(), from.getDate())];
  const d = new Date(out[0]);
  while (out.length < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) out.push(new Date(d)); }
  return out;
}
