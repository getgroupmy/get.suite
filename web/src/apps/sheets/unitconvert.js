// CONVERT(number, from, to), as in Excel and Google Sheets: units by category (mass, distance, time,
// pressure, force, energy, power, magnetism, temperature, volume, area, speed, information), with
// metric prefixes (k, M, m, u…) on metric units and binary ones (ki, Mi, Gi…) on bits and bytes.
// Unit names are case-sensitive, as in Excel. null for units it doesn't know or can't convert between.

// [category, factor to the category's base unit, takes metric prefixes]
const U = {};
const add = (cat, list, metric = false) => { for (const [names, f] of list) for (const n of names.split(' ')) U[n] = [cat, f, metric]; };
add('mass', [['g', 1]], true);
add('mass', [['lbm', 453.59237], ['ozm', 28.349523125], ['stone', 6350.29318], ['ton', 907184.74], ['uk_ton LTON brton', 1016046.9088], ['grain', 0.06479891], ['u', 1.66053906660e-24], ['sg', 14593.90294]]);
add('distance', [['m', 1]], true);
add('distance', [['mi', 1609.344], ['Nmi', 1852], ['in', 0.0254], ['ft', 0.3048], ['yd', 0.9144], ['ang', 1e-10], ['ell', 1.143], ['ly', 9.4607304725808e15], ['Pica', 0.0254 / 6], ['pica', 0.0254 / 72], ['survey_mi', 1609.3472186944]]);
add('time', [['sec s', 1]], true);
add('time', [['yr', 31557600], ['day d', 86400], ['hr', 3600], ['mn min', 60]]);
add('pressure', [['Pa p', 1], ['atm at', 101325], ['mmHg', 133.322387415], ['Torr', 101325 / 760]], true);
add('pressure', [['psi', 6894.757293168361]]);
add('force', [['N', 1], ['dyn dy', 1e-5]], true);
add('force', [['lbf', 4.4482216152605], ['pond', 9.80665e-3]]);
add('energy', [['J', 1], ['e', 1e-7], ['c', 4.184], ['cal', 4.1868], ['eV ev', 1.602176634e-19], ['Wh wh', 3600]], true);
add('energy', [['HPh hh', 2684519.537696172792], ['flb', 1.3558179483314], ['BTU btu', 1055.05585262]]);
add('power', [['W w', 1]], true);
add('power', [['HP h', 745.69987158227022], ['PS', 735.49875]]);
add('magnetism', [['T', 1], ['ga', 1e-4]], true);
add('volume', [['l L lt', 1], ['m3', 1000]], true);
add('volume', [['tsp', 0.00492892159375], ['tspm', 0.005], ['tbs', 0.01478676478125], ['oz', 0.0295735295625], ['cup', 0.2365882365], ['pt us_pt', 0.473176473], ['uk_pt', 0.56826125],
  ['qt', 0.946352946], ['uk_qt', 1.1365225], ['gal', 3.785411784], ['uk_gal', 4.54609], ['ft3 ft^3', 28.316846592], ['in3 in^3', 0.016387064], ['yd3 yd^3', 764.554857984], ['barrel', 158.987294928], ['bushel', 35.23907016688]]);
add('area', [['m2 m^2', 1]], true);
add('area', [['mi2 mi^2', 2589988.110336], ['ft2 ft^2', 0.09290304], ['in2 in^2', 0.00064516], ['yd2 yd^2', 0.83612736], ['ha', 10000], ['ar', 100], ['uk_acre', 4046.8564224], ['us_acre', 4046.872609874252], ['Morgen', 2500]]);
add('speed', [['m/s m/sec', 1], ['m/h m/hr', 1 / 3600]], true);
add('speed', [['mph', 0.44704], ['kn', 1852 / 3600], ['admkn', 1853.184 / 3600]]);
add('information', [['bit', 1], ['byte', 8]], true);
const TEMP = ['C cel', 'F fah', 'K kel', 'Rank', 'Reau'].flatMap((s) => s.split(' '));

const PREFIX = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, e: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24 };
const BINARY = { ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60, Zi: 2 ** 70, Yi: 2 ** 80 };

/** A unit's [category, factor to the base] (with any prefix), or null. Squared and cubed units take the prefix squared or cubed. */
function unit(name) {
  if (U[name]) return U[name];
  for (const [table, binary] of [[BINARY, true], [PREFIX, false]]) {
    for (const p of Object.keys(table).sort((a, b) => b.length - a.length)) {
      if (!name.startsWith(p)) continue;
      const base = U[name.slice(p.length)];
      if (!base || !base[2] || (binary && base[0] !== 'information')) continue;
      const power = /(2|\^2)$/.test(name) ? 2 : /(3|\^3)$/.test(name) ? 3 : 1;
      return [base[0], base[1] * table[p] ** power];
    }
  }
  return null;
}
/** A temperature unit (with a metric prefix on kelvin) to and from kelvin. */
function temp(name) {
  const k = (f) => ({ toK: (x) => x * f, fromK: (x) => x / f });
  if (name === 'C' || name === 'cel') return { toK: (x) => x + 273.15, fromK: (x) => x - 273.15 };
  if (name === 'F' || name === 'fah') return { toK: (x) => ((x - 32) * 5) / 9 + 273.15, fromK: (x) => ((x - 273.15) * 9) / 5 + 32 };
  if (name === 'K' || name === 'kel') return k(1);
  if (name === 'Rank') return k(5 / 9);
  if (name === 'Reau') return { toK: (x) => x * 1.25 + 273.15, fromK: (x) => (x - 273.15) * 0.8 };
  for (const p of Object.keys(PREFIX)) if (name === `${p}K` || name === `${p}kel`) return k(PREFIX[p]);
  return null;
}

/** `value` in unit `from` as unit `to`, or null (unknown units, or of different kinds). */
export function convertUnits(value, from, to) {
  const ta = temp(from), tb = temp(to);
  if (ta || tb) return ta && tb ? tb.fromK(ta.toK(value)) : null;
  const a = unit(from), b = unit(to);
  if (!a || !b || a[0] !== b[0]) return null;
  const out = (value * a[1]) / b[1];
  return Math.abs(out) < 1e-300 ? 0 : Number(out.toPrecision(15));
}
export const UNIT_NAMES = [...Object.keys(U), ...TEMP];
