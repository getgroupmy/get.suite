// What changed in a spreadsheet between an earlier version and now: sheets added, removed or renamed
// (matched by position when the name changed), and each cell typed in, changed or cleared.
import { parseRef } from './formula.js';

const order = (a, b) => { const p = parseRef(a), q = parseRef(b); return p.r - q.r || p.c - q.c; };

/** [{ name, was?, status: 'same' | 'added' | 'removed' | 'renamed', cells: [{ key, was, now, kind: 'add' | 'del' | 'edit' }] }] */
export function sheetChanges(before, after) {
  const old = before?.sheets || [], now = after?.sheets || [];
  const used = new Set();
  const out = [];
  now.forEach((s, i) => {
    let j = old.findIndex((o, k) => !used.has(k) && o.name === s.name);
    const byPlace = j < 0 && old[i] && !used.has(i) && !now.some((x) => x.name === old[i].name) ? i : -1; // renamed in place
    if (j < 0) j = byPlace;
    if (j >= 0) used.add(j);
    const o = j >= 0 ? old[j] : null;
    out.push({ name: s.name, ...(o && o.name !== s.name && { was: o.name }), status: !o ? 'added' : o.name !== s.name ? 'renamed' : 'same', cells: cellChanges(o?.cells || {}, s.cells || {}) });
  });
  old.forEach((o, k) => { if (!used.has(k)) out.push({ name: o.name, status: 'removed', cells: cellChanges(o.cells || {}, {}) }); });
  return out;
}

function cellChanges(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => parseRef(k)).sort(order);
  const out = [];
  for (const key of keys) {
    const was = a[key] ?? '', now = b[key] ?? '';
    if (String(was) === String(now)) continue;
    out.push({ key, was: String(was), now: String(now), kind: was === '' ? 'add' : now === '' ? 'del' : 'edit' });
  }
  return out;
}

/** Counts for a summary line. */
export const changeTotals = (changes) => ({
  cells: changes.reduce((n, s) => n + (s.status === 'removed' ? 0 : s.cells.length), 0),
  sheets: changes.filter((s) => s.status !== 'same').length,
});

/** A spreadsheet with each formula replaced by what it comes to (as shown), for comparing results
 *  with a file that has none (a CSV, or an export). `evaluatorFor(sheets, i)` works a sheet out. */
export function asValues(content, evaluatorFor, show) {
  const sheets = content?.sheets || [];
  return { ...content, sheets: sheets.map((s, i) => {
    const value = evaluatorFor(sheets, i);
    const cells = {};
    for (const [k, raw] of Object.entries(s.cells || {})) {
      const v = typeof raw === 'string' && raw.startsWith('=') ? show(value(k)) : raw;
      if (v !== '' && v != null) cells[k] = v;
    }
    return { ...s, cells };
  }) };
}
