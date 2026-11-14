// Public holidays by country, worked out for any year: the regular national ones (fixed days, those
// counted from Easter, "the first Monday of May" kinds), with the days off given in their place when one
// falls on a weekend where the country does that. One-off days (a coronation, a state funeral) and
// regional ones aren't included: admins add those by hand. Used by Time off → Company holidays.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const plus = (d, n) => new Date(d.getTime() + n * 864e5);

/** Easter Sunday (Gregorian; the "anonymous" algorithm). */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), dd = ((h + l - 7 * m + 114) % 31) + 1;
  return day(y, month, dd);
}
/** The nth weekday (0 Sunday … 6 Saturday) of a month; n = -1 for the last. */
export function nth(y, m, weekday, n) {
  if (n > 0) { const first = day(y, m, 1); return plus(first, ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7); }
  const last = day(y, m + 1, 0);
  return plus(last, -((last.getUTCDay() - weekday + 7) % 7));
}
const MON = 1, THU = 4, SAT = 6, SUN = 0;
/** US federal "observed": Saturday → Friday before, Sunday → Monday after. */
const observedUS = (d) => (d.getUTCDay() === SAT ? plus(d, -1) : d.getUTCDay() === SUN ? plus(d, 1) : d);
/** A weekend day → the next weekday not already taken (UK, Australia: substitute days). */
const nextFree = (d, taken) => { let x = d; while (x.getUTCDay() === SAT || x.getUTCDay() === SUN || taken.has(iso(x))) x = plus(x, 1); return x; };

/** [date, name] pairs → [{ date, name }] sorted, with weekend days moved to substitutes when `substitute`. */
function list(pairs, { substitute = false } = {}) {
  const out = [], taken = new Set();
  // Days that aren't on a weekend keep their place first, so substitutes go round them (Christmas and Boxing Day).
  const sorted = pairs.map(([d, name]) => ({ d, name }));
  for (const h of sorted) if (!substitute || (h.d.getUTCDay() !== SAT && h.d.getUTCDay() !== SUN)) { out.push({ date: iso(h.d), name: h.name }); taken.add(iso(h.d)); }
  if (substitute) {
    for (const h of sorted.filter((x) => x.d.getUTCDay() === SAT || x.d.getUTCDay() === SUN).sort((a, b) => a.d - b.d)) {
      const s = nextFree(h.d, taken);
      taken.add(iso(s));
      out.push({ date: iso(s), name: `${h.name} (substitute day)` });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const RULES = {
  US: { name: 'United States (federal)', days: (y) => list([
    [observedUS(day(y, 1, 1)), "New Year's Day"], [nth(y, 1, MON, 3), 'Martin Luther King Jr. Day'], [nth(y, 2, MON, 3), "Washington's Birthday"],
    [nth(y, 5, MON, -1), 'Memorial Day'], ...(y >= 2021 ? [[observedUS(day(y, 6, 19)), 'Juneteenth']] : []), [observedUS(day(y, 7, 4)), 'Independence Day'],
    [nth(y, 9, MON, 1), 'Labor Day'], [nth(y, 10, MON, 2), 'Columbus Day'], [observedUS(day(y, 11, 11)), 'Veterans Day'],
    [nth(y, 11, THU, 4), 'Thanksgiving Day'], [observedUS(day(y, 12, 25)), 'Christmas Day'],
  ]) },
  GB: { name: 'United Kingdom (England and Wales)', days: (y) => { const e = easter(y); return list([
    [day(y, 1, 1), "New Year's Day"], [plus(e, -2), 'Good Friday'], [plus(e, 1), 'Easter Monday'], [nth(y, 5, MON, 1), 'Early May bank holiday'],
    [nth(y, 5, MON, -1), 'Spring bank holiday'], [nth(y, 8, MON, -1), 'Summer bank holiday'], [day(y, 12, 25), 'Christmas Day'], [day(y, 12, 26), 'Boxing Day'],
  ], { substitute: true }); } },
  IE: { name: 'Ireland', days: (y) => { const e = easter(y); const feb1 = day(y, 2, 1); return list([
    [day(y, 1, 1), "New Year's Day"], ...(y >= 2023 ? [[feb1.getUTCDay() === 5 ? feb1 : nth(y, 2, MON, 1), "St Brigid's Day"]] : []), [day(y, 3, 17), "St Patrick's Day"],
    [plus(e, 1), 'Easter Monday'], [nth(y, 5, MON, 1), 'May bank holiday'], [nth(y, 6, MON, 1), 'June bank holiday'], [nth(y, 8, MON, 1), 'August bank holiday'],
    [nth(y, 10, MON, -1), 'October bank holiday'], [day(y, 12, 25), 'Christmas Day'], [day(y, 12, 26), "St Stephen's Day"],
  ]); } },
  DE: { name: 'Germany (national)', days: (y) => { const e = easter(y); return list([
    [day(y, 1, 1), 'Neujahr'], [plus(e, -2), 'Karfreitag'], [plus(e, 1), 'Ostermontag'], [day(y, 5, 1), 'Tag der Arbeit'], [plus(e, 39), 'Christi Himmelfahrt'],
    [plus(e, 50), 'Pfingstmontag'], [day(y, 10, 3), 'Tag der Deutschen Einheit'], [day(y, 12, 25), '1. Weihnachtstag'], [day(y, 12, 26), '2. Weihnachtstag'],
  ]); } },
  FR: { name: 'France', days: (y) => { const e = easter(y); return list([
    [day(y, 1, 1), "Jour de l'an"], [plus(e, 1), 'Lundi de Pâques'], [day(y, 5, 1), 'Fête du Travail'], [day(y, 5, 8), 'Victoire 1945'], [plus(e, 39), 'Ascension'],
    [plus(e, 50), 'Lundi de Pentecôte'], [day(y, 7, 14), 'Fête nationale'], [day(y, 8, 15), 'Assomption'], [day(y, 11, 1), 'Toussaint'], [day(y, 11, 11), 'Armistice 1918'], [day(y, 12, 25), 'Noël'],
  ]); } },
  NL: { name: 'Netherlands', days: (y) => { const e = easter(y); const king = day(y, 4, 27); return list([
    [day(y, 1, 1), 'Nieuwjaarsdag'], [e, 'Eerste Paasdag'], [plus(e, 1), 'Tweede Paasdag'], [king.getUTCDay() === SUN ? plus(king, -1) : king, 'Koningsdag'],
    [day(y, 5, 5), 'Bevrijdingsdag'], [plus(e, 39), 'Hemelvaartsdag'], [plus(e, 49), 'Eerste Pinksterdag'], [plus(e, 50), 'Tweede Pinksterdag'],
    [day(y, 12, 25), 'Eerste Kerstdag'], [day(y, 12, 26), 'Tweede Kerstdag'],
  ]); } },
  CA: { name: 'Canada (federal)', days: (y) => { const e = easter(y); const jul1 = day(y, 7, 1); return list([
    [day(y, 1, 1), "New Year's Day"], [plus(e, -2), 'Good Friday'], [nth(y, 5, MON, 4).getUTCDate() > 24 ? nth(y, 5, MON, 3) : nth(y, 5, MON, 4), 'Victoria Day'],
    [jul1.getUTCDay() === SUN ? plus(jul1, 1) : jul1, 'Canada Day'], [nth(y, 9, MON, 1), 'Labour Day'],
    ...(y >= 2021 ? [[day(y, 9, 30), 'National Day for Truth and Reconciliation']] : []), [nth(y, 10, MON, 2), 'Thanksgiving'],
    [day(y, 11, 11), 'Remembrance Day'], [day(y, 12, 25), 'Christmas Day'], [day(y, 12, 26), 'Boxing Day'],
  ]); } },
  AU: { name: 'Australia (national)', days: (y) => { const e = easter(y); return [...list([
    [day(y, 1, 1), "New Year's Day"], [day(y, 1, 26), 'Australia Day'], [day(y, 12, 25), 'Christmas Day'], [day(y, 12, 26), 'Boxing Day'],
  ], { substitute: true }), ...list([[plus(e, -2), 'Good Friday'], [plus(e, 1), 'Easter Monday'], [day(y, 4, 25), 'Anzac Day']])].sort((a, b) => a.date.localeCompare(b.date)); } },
};

/** The countries there are rules for: [{ code, name }]. */
export const COUNTRIES = Object.entries(RULES).map(([code, r]) => ({ code, name: r.name }));

/** A country's public holidays in a year: [{ date: 'YYYY-MM-DD', name }], or null for a country without rules. */
export function publicHolidays(country, year) {
  const r = RULES[String(country || '').toUpperCase()];
  const y = Number(year);
  if (!r || !Number.isInteger(y) || y < 1900 || y > 2200) return null;
  return r.days(y);
}
