// Custom number formats (Sheets), written as in Excel and Google Sheets: "#,##0.00", "0%", "0.0,,\"M\"",
// "\"$\"#,##0;[Red]-\"$\"#,##0", "dd/mm/yyyy hh:mm", "0 \"items\"". Up to four sections separated by ";":
// positive; negative; zero; text. A section can start with a colour ([Red]) and/or a condition ([>=100]).
// Supported: 0 # ? digit placeholders, "," thousands (and trailing commas dividing by 1000), "." decimals,
// % and E+00; quoted text, \x, _x (a space) and *x (ignored); @ for the text itself; and dates and times:
// d dd ddd dddd, m mm mmm mmmm (minutes after h or before s), yy yyyy, h hh, s ss, AM/PM.

export const MAX_CODE = 120;
const COLOURS = { red: '#d93025', blue: '#1a73e8', green: '#188038', black: '#202124', white: '#ffffff', magenta: '#a142f4', cyan: '#12b5cb', yellow: '#f9ab00' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EPOCH = Date.UTC(1899, 11, 30);

/** Split on ";" outside quotes and brackets. */
function sections(code) {
  const out = [];
  let cur = '', q = false, br = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\' && !q) { cur += ch + (code[i + 1] ?? ''); i++; continue; }
    if (ch === '"') q = !q;
    else if (!q && ch === '[') br = true;
    else if (!q && ch === ']') br = false;
    if (ch === ';' && !q && !br) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.slice(0, 4);
}

/** A section's colour and condition ([Red][>=100]) taken off its front. */
function head(sec) {
  let colour = null, cond = null, rest = sec;
  for (;;) {
    const m = /^\[([^\]]*)\]/.exec(rest);
    if (!m) break;
    const t = m[1].trim();
    const c = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(t);
    if (c) cond = { op: c[1], n: Number(c[2]) };
    else if (COLOURS[t.toLowerCase()]) colour = COLOURS[t.toLowerCase()];
    else if (/^color\s*\d+$/i.test(t) || /^\$/.test(t)) { /* palette colours and locales: not used */ } else break;
    rest = rest.slice(m[0].length);
  }
  return { colour, cond, body: rest };
}

const test = (c, v) => ({ '<': v < c.n, '>': v > c.n, '=': v === c.n, '<=': v <= c.n, '>=': v >= c.n, '<>': v !== c.n })[c.op];

/** Tokens: { lit } for text to show as it is, or { tok } for a placeholder or date part. */
function tokens(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') { const j = body.indexOf('"', i + 1); out.push({ lit: body.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? body.length : j; continue; }
    if (ch === '\\') { out.push({ lit: body[i + 1] ?? '' }); i++; continue; }
    if (ch === '_') { out.push({ lit: ' ' }); i++; continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '[') { const j = body.indexOf(']', i); i = j < 0 ? body.length : j; continue; } // [h] and the like: not supported, skipped
    const am = /^(AM\/PM|A\/P)/i.exec(body.slice(i));
    if (am) { out.push({ tok: am[1].length > 3 ? 'AM/PM' : 'A/P' }); i += am[1].length - 1; continue; }
    const run = /^(y+|m+|d+|h+|s+)/i.exec(body.slice(i));
    if (run) { out.push({ tok: run[1].toLowerCase(), date: true }); i += run[1].length - 1; continue; }
    if (/[0#?.,%@eE]/.test(ch)) {
      if ((ch === 'e' || ch === 'E') && /^[eE][+-]/.test(body.slice(i))) { out.push({ tok: body.slice(i, i + 2) }); i++; continue; }
      if (ch === 'e' || ch === 'E') { out.push({ lit: ch }); continue; }
      out.push({ tok: ch });
      continue;
    }
    out.push({ lit: ch });
  }
  return out;
}

/** "m" is minutes when it follows an hour or comes before seconds. */
function minutesFix(toks) {
  const parts = toks.filter((t) => t.date);
  parts.forEach((t, i) => {
    if (t.tok[0] !== 'm' || t.tok.length > 2) return;
    if (parts[i - 1]?.tok[0] === 'h' || parts[i + 1]?.tok[0] === 's') t.tok = t.tok === 'mm' ? 'MM' : 'M';
  });
  return toks;
}

/** A date as days since 1899-12-30 (with the time as a fraction), from a number or "2026-11-09[ 14:30]". */
function serialOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v.trim());
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - EPOCH) / 864e5;
}

function formatDate(v, toks) {
  const serial = serialOf(v);
  if (serial === null || serial < 0 || serial > 2958466) return null;
  const ms = Math.round(serial * 864e5) + EPOCH;
  const d = new Date(ms);
  const H = d.getUTCHours();
  const ampm = toks.some((t) => t.tok === 'AM/PM' || t.tok === 'A/P');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return toks.map((t) => {
    if (t.lit !== undefined) return t.lit;
    switch (t.tok) {
      case 'yy': return pad(d.getUTCFullYear() % 100);
      case 'd': return String(d.getUTCDate());
      case 'dd': return pad(d.getUTCDate());
      case 'ddd': return DAYS[d.getUTCDay()].slice(0, 3);
      case 'm': return String(d.getUTCMonth() + 1);
      case 'mm': return pad(d.getUTCMonth() + 1);
      case 'mmm': return MONTHS[d.getUTCMonth()].slice(0, 3);
      case 'mmmmm': return MONTHS[d.getUTCMonth()][0];
      case 'M': return String(d.getUTCMinutes());
      case 'MM': return pad(d.getUTCMinutes());
      case 'h': return String(ampm ? (H % 12 || 12) : H);
      case 'hh': return pad(ampm ? (H % 12 || 12) : H);
      case 's': return String(d.getUTCSeconds());
      case 'ss': return pad(d.getUTCSeconds());
      case 'AM/PM': return H < 12 ? 'AM' : 'PM';
      case 'A/P': return H < 12 ? 'A' : 'P';
      default:
        if (/^y{3,}$/.test(t.tok)) return String(d.getUTCFullYear());
        if (/^d{4,}$/.test(t.tok)) return DAYS[d.getUTCDay()];
        if (/^m{4}$/.test(t.tok)) return MONTHS[d.getUTCMonth()];
        if (/^[hs]+$/.test(t.tok)) return pad(t.tok[0] === 'h' ? H : d.getUTCSeconds());
        return t.tok;
    }
  }).join('');
}

/** Digits for placeholders: 0 always shows, # only when needed, ? as a space. */
function fill(digits, places, fromLeft) {
  // places: array of '0' | '#' | '?' for the integer part (fromLeft false) or the decimals (fromLeft true)
  const out = [];
  if (!fromLeft) {
    const ds = digits.split('');
    for (let i = places.length - 1; i >= 0; i--) {
      const dgt = ds.pop();
      out.unshift(dgt !== undefined ? dgt : places[i] === '0' ? '0' : places[i] === '?' ? ' ' : '');
    }
    if (ds.length) out[0] = ds.join('') + out[0]; // more digits than places: all of them show
    return out;
  }
  for (let i = 0; i < places.length; i++) {
    const dgt = digits[i];
    out.push(dgt !== undefined ? dgt : places[i] === '0' ? '0' : places[i] === '?' ? ' ' : '');
  }
  // trailing zeros only where the placeholder is 0
  for (let i = out.length - 1; i >= 0 && places[i] !== '0' && out[i] === '0'; i--) out[i] = places[i] === '?' ? ' ' : '';
  return out;
}

function formatNumberCode(n, toks, negSection) {
  const ph = toks.filter((t) => t.tok && !t.date);
  const dot = toks.findIndex((t) => t.tok === '.');
  const eAt = toks.findIndex((t) => /^[eE][+-]$/.test(t.tok || ''));
  const isPh = (t) => t.tok === '0' || t.tok === '#' || t.tok === '?';
  // Trailing commas right after the last digit placeholder divide by 1000 each.
  let lastPh = -1;
  toks.forEach((t, i) => { if (isPh(t) && (eAt < 0 || i < eAt)) lastPh = i; });
  let scale = 0;
  for (let i = lastPh + 1; i < toks.length && toks[i].tok === ','; i++) { scale++; toks[i] = { lit: '' }; }
  const grouping = toks.some((t, i) => t.tok === ',' && i < (dot < 0 ? lastPh : dot) && toks.slice(0, i).some(isPh));
  const intEnd = dot >= 0 ? dot : eAt >= 0 ? eAt : toks.length;
  const intPlaces = toks.slice(0, intEnd).filter(isPh).map((t) => t.tok);
  const decPlaces = dot >= 0 ? toks.slice(dot + 1, eAt >= 0 ? eAt : toks.length).filter(isPh).map((t) => t.tok) : [];
  let x = Math.abs(n);
  if (ph.some((t) => t.tok === '%')) x *= 100 ** ph.filter((t) => t.tok === '%').length;
  x /= 1000 ** scale;
  let exp = 0;
  if (eAt >= 0 && x !== 0) {
    const intDigits = Math.max(1, intPlaces.length);
    exp = Math.floor(Math.log10(x)) - (intDigits - 1);
    x /= 10 ** exp;
  }
  const fixed = x.toFixed(Math.min(20, decPlaces.length));
  let [ip, dp = ''] = fixed.split('.');
  if (ip === '0' && intPlaces.length && !intPlaces.includes('0')) ip = '';
  let intDigits = fill(ip, intPlaces.length ? intPlaces : ['#'], false).join('');
  if (grouping) intDigits = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decDigits = fill(dp, decPlaces, true).join('');
  // Lay the digits back over the tokens: the integer digits at the first integer placeholder, the decimals at the first decimal one.
  let out = '', intDone = false, decDone = false;
  toks.forEach((t, i) => {
    if (t.lit !== undefined) { out += t.lit; return; }
    if (t.tok === ',') return;
    if (t.tok === '%') { out += '%'; return; }
    if (t.tok === '.') { out += decPlaces.length || decDigits ? '.' : ''; return; }
    if (/^[eE][+-]$/.test(t.tok)) {
      const expPlaces = toks.slice(i + 1).filter(isPh).length || 1;
      out += `E${exp < 0 ? '-' : t.tok[1] === '+' ? '+' : ''}${String(Math.abs(exp)).padStart(expPlaces, '0')}`;
      return;
    }
    if (!isPh(t)) { out += t.tok === '@' ? '' : t.tok; return; }
    if (eAt >= 0 && i > eAt) return; // exponent digits: written above
    if (dot < 0 || i < dot) { if (!intDone) { out += intDigits; intDone = true; } } else if (!decDone) { out += decDigits; decDone = true; }
  });
  if (out.endsWith('.') && !decPlaces.length) out = out.slice(0, -1);
  const zero = !/[1-9]/.test(out);
  return n < 0 && !negSection && !zero ? `-${out}` : out;
}

/**
 * The value as the code shows it: { text, colour } (colour may be null), or null when the code
 * doesn't apply (an error, an empty cell, or text with no text section).
 */
export function formatCode(v, code) {
  if (v === null || v === undefined || v === '' || (typeof v === 'object' && !Array.isArray(v))) return null;
  const secs = sections(String(code || '').slice(0, MAX_CODE)).map(head);
  if (!secs.length) return null;
  const textSec = secs.length === 4 ? secs[3] : secs.find((s) => s.body.includes('@') && !/[0#?]/.test(s.body.replace(/"[^"]*"/g, '')));
  const isDate = (s) => tokens(s.body).some((t) => t.date) && !tokens(s.body).some((t) => /^[0#?]$/.test(t.tok || ''));
  // Text: only a text section (or a date code for a date written as text) changes it.
  if (typeof v === 'string' || typeof v === 'boolean') {
    if (typeof v === 'string' && isDate(secs[0]) && serialOf(v) !== null) return { text: formatDate(v, minutesFix(tokens(secs[0].body))), colour: secs[0].colour };
    if (!textSec) return null;
    const text = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
    return { text: tokens(textSec.body).map((t) => (t.lit !== undefined ? t.lit : t.tok === '@' ? text : '')).join(''), colour: textSec.colour };
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Which section: conditions first, then positive; negative; zero.
  const numSecs = secs.length === 4 || textSec === secs[secs.length - 1] && secs.length > 1 ? secs.slice(0, -1) : secs;
  let sec, neg = false;
  if (numSecs.some((s) => s.cond)) {
    sec = numSecs.find((s) => s.cond && test(s.cond, v)) || numSecs.find((s) => !s.cond) || numSecs[0];
    neg = sec !== numSecs[0] && v < 0;
  } else if (v < 0 && numSecs.length >= 2) { sec = numSecs[1]; neg = true; } else if (v === 0 && numSecs.length >= 3) sec = numSecs[2];
  else sec = numSecs[0];
  const toks = minutesFix(tokens(sec.body));
  if (!toks.length) return { text: '', colour: sec.colour };
  if (isDate(sec)) { const d = formatDate(v, toks); return d === null ? null : { text: d, colour: sec.colour }; }
  if (!toks.some((t) => /^[0#?]$/.test(t.tok || ''))) return { text: toks.map((t) => (t.lit !== undefined ? t.lit : t.tok === '@' ? String(v) : t.tok === ',' ? '' : t.tok)).join(''), colour: sec.colour }; // all text: "Nil", "-"
  return { text: formatNumberCode(neg ? -Math.abs(v) : v, toks, neg), colour: sec.colour };
}

/** A code worth keeping: trimmed, not too long, with something in it. */
export function cleanCode(code) {
  const c = String(code ?? '').replace(/[\r\n]/g, '').trim().slice(0, MAX_CODE);
  return c || null;
}

/** Codes to choose from, with what 1234.5 (or a date) looks like. */
export const CODE_EXAMPLES = [
  '#,##0', '#,##0.00', '0.0%', '"RM"#,##0.00', '#,##0;[Red]-#,##0', '#,##0.00;(#,##0.00)', '0.0,,"M"', '0.00E+00',
  '0 "items"', 'dd/mm/yyyy', 'd mmm yyyy', 'dddd', 'hh:mm', 'h:mm AM/PM', 'yyyy-mm-dd hh:mm',
];
