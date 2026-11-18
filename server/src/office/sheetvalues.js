// Formula results for downloads: each sheet's formula cells worked out with the Sheets engine (sheetcalc/),
// so a file opened somewhere that doesn't calculate (a phone's preview, Quick Look, a mail app) still shows
// them. Plain values only: a number, text, TRUE/FALSE or an error code; null when there's nothing sure to give.
import { bookEvaluator } from '../sheetcalc/formula.js';

/** For sheet `index` of `data`: key → { number } | { text } | { bool } | { error } | null. */
export function formulaResults(data, index) {
  let ev = null;
  try { ev = bookEvaluator(data?.sheets || [], index); } catch { ev = null; }
  return (key) => {
    if (!ev) return null;
    let v;
    try { v = ev(key); } catch { return null; }
    if (Array.isArray(v)) v = v[0]?.[0] ?? v[0]; // (an array's first value: what its own cell shows)
    if (v === null || v === undefined) return { text: '' };
    if (typeof v === 'number') return Number.isFinite(v) ? { number: v } : null;
    if (typeof v === 'boolean') return { bool: v };
    if (typeof v === 'string') return { text: v };
    if (typeof v === 'object' && typeof v.error === 'string') return { error: v.error };
    return null;
  };
}

/** One sheet's cells as CSV (or TSV with sep '\t'): the values the page shows (number formats too), row by row. */
export async function delimitedFromSheet(data, index = 0, sep = ',') {
  const { bookEvaluator: be, display, parseRef } = await import('../sheetcalc/formula.js');
  const { formatNumber } = await import('../sheetcalc/cellformat.js');
  const s = data?.sheets?.[index] || { cells: {} };
  let ev;
  try { ev = be(data?.sheets || [], index); } catch { ev = () => ''; }
  let maxR = -1, maxC = -1;
  for (const k of [...Object.keys(s.cells || {}), ...(ev.spilledKeys?.() || [])]) { const p = parseRef(k); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
  const { colName } = await import('../sheetcalc/formula.js');
  const out = [];
  for (let r = 0; r <= Math.min(maxR, 100000); r++) {
    const row = [];
    for (let c = 0; c <= Math.min(maxC, 1000); c++) {
      const k = `${colName(c)}${r + 1}`;
      let v; try { v = ev(k); } catch { v = { error: '#ERROR!' }; }
      const t = String(formatNumber(v, s.formats?.[k]) ?? display(v));
      row.push(sep === '\t' ? t.replace(/[\t\r\n]+/g, ' ') : /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    }
    out.push(row.join(sep));
  }
  return out.join('\r\n') + (out.length ? '\r\n' : '');
}

/**
 * A spreadsheet as text for reading (an assistant's fetch): each sheet under its name, its used cells as a
 * tab-separated table of the values shown (row numbers and column letters given), then its formulas with what
 * they give. Hidden sheets are marked as such.
 */
export async function sheetReadingText(data, { maxCells = 20000 } = {}) {
  const { colName, parseRef } = await import('../sheetcalc/formula.js');
  const out = [];
  let budget = maxCells;
  for (const [i, s] of (data?.sheets || []).entries()) {
    const tsv = (await delimitedFromSheet(data, i, '\t')).replace(/\r\n$/, '').split('\r\n');
    const width = Math.max(0, ...tsv.map((l) => l.split('\t').length));
    out.push(`## Sheet: ${s.name}${s.hidden ? ' (hidden)' : ''}`);
    if (!tsv[0] && tsv.length <= 1) { out.push('(empty)'); continue; }
    out.push(['', ...Array.from({ length: width }, (_, c) => colName(c))].join('\t'));
    for (const [r, line] of tsv.entries()) {
      if (budget <= 0) { out.push('… (more rows left out)'); break; }
      budget -= width;
      if (line.replace(/\t/g, '')) out.push(`${r + 1}\t${line}`);
    }
    const results = formulaResults(data, i);
    const formulas = Object.entries(s.cells || {}).filter(([k, v]) => typeof v === 'string' && v.startsWith('=') && parseRef(k)).slice(0, 500);
    if (formulas.length) {
      out.push('', 'Formulas:');
      for (const [k, v] of formulas) { const r = results(k); const shown = !r ? '' : 'number' in r ? r.number : 'bool' in r ? (r.bool ? 'TRUE' : 'FALSE') : 'error' in r ? r.error : r.text; out.push(`${k}: ${v} → ${shown}`); }
    }
    out.push('');
  }
  return out.join('\n').trim();
}
