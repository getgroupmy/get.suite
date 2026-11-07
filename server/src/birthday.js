// Birthdays on contacts: "YYYY-MM-DD", or "--MM-DD" when the year isn't known (as vCard writes it).

/** A birthday in any common written form (vCard 3/4, ISO, Gmail's CSV) as stored, or null. Throws on nonsense when strict. */
export function birthdayOf(v, { strict = false } = {}) {
  const s = String(v ?? '').trim().replace(/T.*$/, ''); // vCard may add a time
  if (!s) return null;
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  let y = m?.[1], mo = m?.[2], d = m?.[3];
  if (!m) { m = /^--(\d{2})-?(\d{2})$/.exec(s); mo = m?.[1]; d = m?.[2]; }
  if (!m) { m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (m) { mo = m[1].padStart(2, '0'); d = m[2].padStart(2, '0'); y = m[3]; } } // US style, as Outlook writes
  if (y === '1604') y = undefined; // Apple's "no year" placeholder
  const ok = m && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= new Date(Date.UTC(y ? +y : 2000, +mo, 0)).getUTCDate() && (!y || (+y >= 1850 && +y <= 2200));
  if (!ok) { if (strict) throw new Error('Birthday must be a date (YYYY-MM-DD, or --MM-DD without the year)'); return null; }
  return y ? `${y}-${mo}-${d}` : `--${mo}-${d}`;
}

/**
 * Each birthday falling between two dates (YYYY-MM-DD, both included):
 * [{ date, age }] — age when the year is known. 29 Feb is kept on 28 Feb in other years.
 */
export function birthdaysBetween(birthday, from, to) {
  const b = birthdayOf(birthday);
  if (!b) return [];
  const year0 = b.startsWith('--') ? null : Number(b.slice(0, 4));
  const [mo, d] = b.slice(-5).split('-');
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const last = new Date(Date.UTC(y, Number(mo), 0)).getUTCDate();
    const date = `${y}-${mo}-${String(Math.min(Number(d), last)).padStart(2, '0')}`;
    if (date >= from && date <= to && (year0 === null || y >= year0)) out.push({ date, age: year0 === null ? null : y - year0 });
  }
  return out;
}
