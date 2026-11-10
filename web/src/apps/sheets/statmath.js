// The maths behind the statistics, finance and date functions that need more than a line: the normal,
// t, chi-squared, binomial and Poisson distributions (through the incomplete gamma and beta functions),
// depreciation, the interest and capital in a loan payment, and fractions of a year. Plain numbers in
// and out; formula.js checks the arguments and turns problems into #NUM! and the like.

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
/** ln Γ(x), for x > 0. */
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-15, TINY = 1e-300;
/** The regularized lower incomplete gamma function P(a, x). */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) { // the series
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 1000; n++) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * EPS) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // the continued fraction for Q, by Lentz's method
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

function betaFraction(a, b, x) {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** The regularized incomplete beta function I_x(a, b). */
export function betaI(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/** The standard normal distribution: the share below z, and the height of the curve at z. */
export const normCdf = (z) => (z < 0 ? 0.5 * (1 - gammaP(0.5, (z * z) / 2)) : 0.5 * (1 + gammaP(0.5, (z * z) / 2)));
export const normPdf = (z) => Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
/** The z with a share p below it (0 < p < 1): Acklam's approximation, then two Newton steps. */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - lo) { const q = p - 0.5, r = q * q; x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  for (let i = 0; i < 2; i++) { const e = normCdf(x) - p; x -= e / normPdf(x); }
  return x;
}

/** Student's t: the share below t with df degrees of freedom, and the curve's height. */
export function tCdf(t, df) {
  const tail = 0.5 * betaI(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - tail : tail;
}
export const tPdf = (t, df) => Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (t * t) / df));
/** The t with a share p below it, by halving the interval it must be in. */
export function tInv(p, df) {
  let lo = -1e3, hi = 1e3;
  while (tCdf(lo, df) > p) lo *= 10;
  while (tCdf(hi, df) < p) hi *= 10;
  for (let i = 0; i < 200 && hi - lo > 1e-13 * Math.max(1, Math.abs(lo)); i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Chi-squared: the share below x with df degrees of freedom, and the curve's height. */
export const chiCdf = (x, df) => (x <= 0 ? 0 : gammaP(df / 2, x / 2));
export const chiPdf = (x, df) => (x <= 0 ? 0 : Math.exp((df / 2 - 1) * Math.log(x) - x / 2 - (df / 2) * Math.LN2 - lnGamma(df / 2)));

/** The chance of exactly k successes in n tries at p each; and of k or fewer. */
export function binomPmf(k, n, p) {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
export const binomCdf = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return Math.min(1, s); };
/** The chance of exactly k events when mean are expected; and of k or fewer. */
export const poissonPmf = (k, mean) => (mean === 0 ? (k === 0 ? 1 : 0) : Math.exp(k * Math.log(mean) - mean - lnGamma(k + 1)));
export const poissonCdf = (k, mean) => (mean === 0 ? 1 : 1 - gammaP(k + 1, mean));

/** The p-value of Student's t-test: type 1 paired, 2 two samples with equal variance, 3 unequal (Welch). */
export function tTest(xs, ys, tails, type) {
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sv = (a) => { const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1); };
  let t, df;
  if (type === 1) {
    const d = xs.map((x, i) => x - ys[i]);
    if (d.length < 2) return null;
    df = d.length - 1;
    t = mean(d) / Math.sqrt(sv(d) / d.length);
  } else {
    const n1 = xs.length, n2 = ys.length;
    if (n1 < 2 || n2 < 2) return null;
    const v1 = sv(xs), v2 = sv(ys);
    if (type === 2) {
      df = n1 + n2 - 2;
      const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / df;
      t = (mean(xs) - mean(ys)) / Math.sqrt(pooled * (1 / n1 + 1 / n2));
    } else {
      const a = v1 / n1, b = v2 / n2;
      df = (a + b) ** 2 / (a ** 2 / (n1 - 1) + b ** 2 / (n2 - 1));
      t = (mean(xs) - mean(ys)) / Math.sqrt(a + b);
    }
  }
  if (!Number.isFinite(t)) return null;
  return tails * (1 - tCdf(Math.abs(t), df));
}

// ---- loans and depreciation (Excel's conventions: money paid out is negative)
export function payment(rate, n, pv, fv = 0, type = 0) {
  if (!rate) return -(pv + fv) / n;
  const g = (1 + rate) ** n;
  return -(rate * (fv + pv * g)) / ((1 + rate * type) * (g - 1));
}
export function futureValue(rate, n, pmt, pv, type = 0) {
  if (!rate) return -(pv + pmt * n);
  const g = (1 + rate) ** n;
  return -(pv * g + (pmt * (1 + rate * type) * (g - 1)) / rate);
}
/** The interest in payment number per (1 to n). */
export function interestPart(rate, per, n, pv, fv = 0, type = 0) {
  const pmt = payment(rate, n, pv, fv, type);
  if (type === 1 && per === 1) return 0;
  const owed = futureValue(rate, per - 1, pmt, pv, type);
  const i = owed * rate;
  return type === 1 ? i / (1 + rate) : i;
}
export const capitalPart = (rate, per, n, pv, fv = 0, type = 0) => payment(rate, n, pv, fv, type) - interestPart(rate, per, n, pv, fv, type);

/** Double-declining (or any factor) balance depreciation in one period. */
export function ddb(cost, salvage, life, period, factor = 2) {
  let book = cost, dep = 0;
  for (let p = 1; p <= Math.ceil(period); p++) {
    dep = Math.min(book * (factor / life), Math.max(0, book - salvage));
    book -= dep;
  }
  return dep;
}
/** Fixed-declining balance depreciation (Excel's DB), with `month` months in the first year. */
export function db(cost, salvage, life, period, month = 12) {
  const rate = Math.round((1 - (salvage / cost) ** (1 / life)) * 1000) / 1000;
  let total = 0, dep = 0;
  for (let p = 1; p <= period; p++) {
    if (p === 1) dep = (cost * rate * month) / 12;
    else if (p === life + 1) dep = ((cost - total) * rate * (12 - month)) / 12;
    else dep = (cost - total) * rate;
    total += dep;
  }
  return dep;
}

// ---- dates
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** The fraction of a year between two dates (UTC ms), by one of Excel's five day counts. */
export function yearFrac(a, b, basis = 0) {
  if (a > b) [a, b] = [b, a];
  const d1 = new Date(a), d2 = new Date(b);
  let y1 = d1.getUTCFullYear(), m1 = d1.getUTCMonth() + 1, dd1 = d1.getUTCDate();
  let y2 = d2.getUTCFullYear(), m2 = d2.getUTCMonth() + 1, dd2 = d2.getUTCDate();
  const days = Math.round((b - a) / 864e5);
  const lastOfFeb = (y, m, d) => m === 2 && d === (isLeap(y) ? 29 : 28);
  switch (basis) {
    case 0: { // US 30/360
      if (lastOfFeb(y1, m1, dd1) && lastOfFeb(y2, m2, dd2)) dd2 = 30;
      if (lastOfFeb(y1, m1, dd1)) dd1 = 30;
      if (dd2 === 31 && dd1 >= 30) dd2 = 30;
      if (dd1 === 31) dd1 = 30;
      return ((y2 - y1) * 360 + (m2 - m1) * 30 + (dd2 - dd1)) / 360;
    }
    case 4: // European 30/360
      if (dd1 === 31) dd1 = 30;
      if (dd2 === 31) dd2 = 30;
      return ((y2 - y1) * 360 + (m2 - m1) * 30 + (dd2 - dd1)) / 360;
    case 2: return days / 360;
    case 3: return days / 365;
    default: { // 1: actual/actual
      const withinAYear = y1 === y2 || (y2 === y1 + 1 && (m1 > m2 || (m1 === m2 && dd1 >= dd2)));
      if (withinAYear) {
        let len = 365;
        if (y1 === y2 && isLeap(y1)) len = 366;
        else if (y1 !== y2) {
          const feb29 = (y) => Date.UTC(y, 1, 29);
          if ((isLeap(y1) && a <= feb29(y1)) || (isLeap(y2) && b >= feb29(y2))) len = 366;
        }
        return days / len;
      }
      let total = 0;
      for (let y = y1; y <= y2; y++) total += isLeap(y) ? 366 : 365;
      return days / (total / (y2 - y1 + 1));
    }
  }
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (w) => { const i = MONTH_NAMES.indexOf(String(w).slice(0, 3).toLowerCase()); return i < 0 ? null : i; };
/**
 * A date written in words or numbers, as UTC ms, or null: 2026-11-09, 9 Nov 2026, 9 November, Nov 9, 2026,
 * November 9 2026, 9/11/2026 (day first unless that can't be, or `monthFirst`), 2026/11/09. A missing year is
 * this year. A time after it is left out.
 */
export function parseDateText(text, { monthFirst = false, year = new Date().getUTCFullYear() } = {}) {
  const t = String(text ?? '').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m, y, mo, d;
  const fullYear = (s) => { const n = +s; return s.length <= 2 ? (n < 50 ? 2000 + n : 1900 + n) : n; };
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t))) [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?(?: .*)?$/.exec(t))) {
    const a = +m[1], b = +m[2];
    let dayFirst = !monthFirst;
    if (dayFirst && b > 12 && a <= 12) dayFirst = false;
    else if (!dayFirst && a > 12 && b <= 12) dayFirst = true;
    [d, mo] = dayFirst ? [a, b - 1] : [b, a - 1];
    y = m[3] ? fullYear(m[3]) : year;
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+)\.?(?: (\d{2}|\d{4}))?$/.exec(t))) [d, mo, y] = [+m[1], monthOf(m[2]), m[3] ? fullYear(m[3]) : year];
  else if ((m = /^([A-Za-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t))) [mo, d, y] = [monthOf(m[1]), +m[2], m[3] ? +m[3] : year];
  else if ((m = /^([A-Za-z]+)\.? (\d{4})$/.exec(t))) [mo, d, y] = [monthOf(m[1]), 1, +m[2]];
  else return null;
  if (mo === null || mo < 0 || mo > 11 || d < 1) return null;
  const ms = Date.UTC(y, mo, d);
  return new Date(ms).getUTCDate() === d ? ms : null; // not 31 April
}
/** A time of day written as 14:30, 2:30 pm, 14:30:15 (perhaps after a date), as a fraction of a day, or null. */
export function parseTimeText(text) {
  const m = /(?:^|\s|T)(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([ap]\.?m\.?)?\s*$/i.exec(String(text ?? '').trim())
    || /^(\d{1,2})()()\s*([ap]\.?m\.?)$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0), s = +(m[3] || 0);
  if (m[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/^p/i.test(m[4]) ? 12 : 0); }
  if (h > 23 || min > 59 || s >= 60) return null;
  return (h * 3600 + min * 60 + s) / 86400;
}
