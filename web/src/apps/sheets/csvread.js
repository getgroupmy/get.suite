// Reading CSV files, in the browser (Sheets → Import CSV) and on the server (contacts, tasks, calendars, people, sheet
// uploads): the same code. server/src/sheetcalc/csvread.js is a copy of web/src/apps/sheets/csvread.js; keep them the
// same (test/sheetcalc.test.js checks). test/csvoracle.test.js checks it against Python's csv module.

/** CSV text → rows of fields with this separator (quoted fields may hold separators, quotes and new lines). */
function splitCsv(src, sep, maxRows = Infinity) {
  const rows = [];
  let row = [], field = '', quoted = false, seen = false; // seen: anything in this row yet ("" is an empty field)
  for (let i = 0; i < src.length && rows.length < maxRows; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') { quoted = true; seen = true; }
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; seen = false;
    } else field += ch;
  }
  if ((field || row.length || seen) && rows.length < maxRows) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Comma or semicolon (Excel in much of Europe saves CSV with ";"), much as Python's csv.Sniffer decides: read the first
 * rows both ways; a separator counts when it splits rows, and the one whose most common number of fields (above one)
 * the most rows share wins (notes lines before the header, as LinkedIn's export has, don't change that). Even both
 * ways, commas mostly between digits (1,5) are decimal commas: semicolons. Separators inside quotes don't count, so
 * "Smith, John";"x" is semicolons, and a quoted line break doesn't end a row early.
 */
export function csvSeparator(src) {
  const score = (sep) => {
    const rows = splitCsv(src, sep, 30).filter((r) => r.some((f) => f !== ''));
    const counts = new Map();
    for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    const [mode, n] = [...counts].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0] || [0, 0];
    return { share: rows.length ? n / rows.length : 0, mode };
  };
  const c = score(','), sc = score(';');
  if (!sc.mode) return ',';
  if (!c.mode) return ';';
  if (sc.share !== c.share) return sc.share > c.share ? ';' : ',';
  let commas = 0, decimal = 0, quoted = false;
  for (let i = 0; i < Math.min(src.length, 20000); i++) {
    if (src[i] === '"') quoted = !quoted;
    else if (!quoted && src[i] === ',') { commas++; if (/\d/.test(src[i - 1] || '') && /\d/.test(src[i + 1] || '')) decimal++; }
  }
  if (commas && decimal * 2 > commas) return ';';
  return sc.mode > c.mode ? ';' : ',';
}

/** CSV text → rows of fields (quoted fields may hold commas, quotes and new lines). Semicolons work as separators too. */
export function parseCsv(text, { keepEmpty = false } = {}) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = splitCsv(src, csvSeparator(src));
  return keepEmpty ? rows : rows.filter((r) => r.some((f) => f.trim())); // keepEmpty: blank rows stay, so row numbers do
}
