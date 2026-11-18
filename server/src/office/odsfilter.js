// A sheet's filter in OpenDocument spreadsheets, as LibreOffice keeps an AutoFilter: a database range with
// filter buttons over the filter's range, its conditions in a table:filter. Sheets keeps the values each
// column hides ({ hidden: { B: ['Done', ''] } }, "" = empty cells) and conditions ({ cond: { C: { op, a, b } } });
// LibreOffice keeps the values to show, so they're worked out from the cells (their stored values: a formula's
// result isn't known here) both ways.
import { meetsCondition, cleanCondition } from './filtercond.js';

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const sheetRef = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
const NONE = '\u200b'; // a value no cell has (see filterToOds)
const OPS = { empty: 'empty', notempty: '!empty', contains: 'contains', notcontains: '!contains', starts: 'begins', ends: 'ends', is: '=', eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** The filter's area: its range, reaching down to the last row with something in its columns (as Sheets does). */
function area(filter, cells) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(filter?.range || ''));
  if (!m) return null;
  const [c1, r1, c2] = [colIndex(m[1]), Number(m[2]), colIndex(m[3])];
  let r2 = Number(m[4]);
  for (const k of Object.keys(cells || {})) {
    const p = /^([A-Z]+)(\d+)$/.exec(k);
    if (!p || cells[k] === '' || cells[k] === undefined) continue;
    const c = colIndex(p[1]), r = Number(p[2]);
    if (c >= c1 && c <= c2 && r > r2 && r <= r2 + 1000) r2 = r;
  }
  return { c1, r1, c2, r2 };
}
const stored = (cells, key) => { const v = cells?.[key]; return typeof v === 'string' && v.startsWith('=') ? undefined : v === undefined || v === null ? '' : String(v).trim(); };

/** The filter as a table:database-range, and the rows (1-based) it hides. Null when there's no filter. */
export function filterToOds(filter, cells, sheetName) {
  const g = area(filter, cells);
  if (!g) return null;
  const sh = sheetRef(sheetName);
  const conds = [];
  const hiddenRows = new Set();
  for (let c = g.c1; c <= g.c2; c++) {
    const col = colName(c), field = c - g.c1;
    const hide = new Set((filter.hidden?.[col] || []).map(String));
    if (hide.size) {
      const values = new Set();
      for (let r = g.r1 + 1; r <= g.r2; r++) { const v = stored(cells, `${col}${r}`); if (v !== undefined) values.add(v); }
      // (with a value no cell has, a zero-width space, when fewer than two show: LibreOffice turns a list of one into a
      // plain "equals" condition, and a list of none means nothing to it)
      const shown = [...values].filter((v) => !hide.has(v));
      if (shown.length < 2) shown.push(NONE);
      conds.push(`<table:filter-condition table:field-number="${field}" table:value="${x(shown[0] ?? '')}" table:operator="=">${shown.map((v) => `<table:filter-set-item table:value="${x(v)}"/>`).join('')}</table:filter-condition>`);
    }
    const cond = cleanCondition(filter.cond?.[col]);
    if (cond) {
      const one = (op, v) => `<table:filter-condition table:field-number="${field}" table:value="${x(v ?? '')}" table:operator="${x(op)}"/>`;
      if (cond.op === 'between') conds.push(one('>=', cond.a), one('<=', cond.b));
      else if (cond.op === 'notbetween') conds.push(`<table:filter-or>${one('<', cond.a)}${one('>', cond.b)}</table:filter-or>`);
      else if (OPS[cond.op]) conds.push(one(OPS[cond.op], cond.a));
    }
    if (hide.size || cond) for (let r = g.r1 + 1; r <= g.r2; r++) {
      const v = stored(cells, `${col}${r}`);
      if (v !== undefined && ((hide.size && hide.has(v)) || (cond && !meetsCondition(cond, v)))) hiddenRows.add(r);
    }
  }
  const target = `${sh}.${colName(g.c1)}${g.r1}:${sh}.${colName(g.c2)}${g.r2}`;
  const xml = `<table:database-range table:name="__Anonymous_Sheet_DB__${x(String(sheetName).replace(/[^A-Za-z0-9]/g, ''))}" table:target-range-address="${x(target)}" table:display-filter-buttons="true">${conds.length ? `<table:filter><table:filter-and>${conds.join('')}</table:filter-and></table:filter>` : ''}</table:database-range>`;
  return { xml, hiddenRows };
}

/**
 * A sheet's filter from the database ranges of the file: the one with filter buttons on this sheet.
 * `tags(el, name)` lists an element's children.
 */
export function filterFromOds(ranges, sheetName, cells, tags) {
  for (const db of ranges) {
    if (db.attribs['table:display-filter-buttons'] !== 'true') continue;
    const t = /^(?:'((?:[^']|'')*)'|([^.]+))\.\$?([A-Z]+)\$?(\d+):(?:'(?:[^']|'')*'|[^.]+)\.\$?([A-Z]+)\$?(\d+)$/.exec(String(db.attribs['table:target-range-address'] || ''));
    if (!t || (t[1] !== undefined ? t[1].replace(/''/g, "'") : t[2]) !== sheetName) continue;
    const range = `${t[3]}${t[4]}:${t[5]}${t[6]}`;
    const g = area({ range }, cells);
    const hidden = {}, cond = {};
    const walk = (el, inOr) => {
      for (const k of tags(el)) {
        if (k.name === 'table:filter-and') walk(k, false);
        else if (k.name === 'table:filter-or') walk(k, true);
        else if (k.name === 'table:filter-condition') {
          const col = colName(g.c1 + (Number(k.attribs['table:field-number']) || 0));
          const op = k.attribs['table:operator'], v = k.attribs['table:value'] ?? '';
          const set = tags(k, 'table:filter-set-item').map((s) => s.attribs['table:value'] ?? '');
          if ((op === '=' && set.length) || (op === '=' && v === NONE)) {
            const shown = new Set(set.length ? set : [v]);
            const values = new Set();
            for (let r = g.r1 + 1; r <= g.r2; r++) { const sv = stored(cells, `${col}${r}`); if (sv !== undefined) values.add(sv); }
            const hide = [...values].filter((sv) => !shown.has(sv));
            if (hide.length) hidden[col] = hide;
            continue;
          }
          const prev = cond[col];
          if (inOr && prev?.op === 'lt' && op === '>') cond[col] = { op: 'notbetween', a: prev.a, b: v };
          else if (!inOr && prev?.op === 'gte' && op === '<=') cond[col] = { op: 'between', a: prev.a, b: v };
          else {
            const ours = op === '=' ? (v !== '' && !Number.isNaN(Number(v)) ? 'eq' : 'is') : Object.keys(OPS).find((o) => OPS[o] === op && o !== 'is' && o !== 'eq');
            const c = ours && cleanCondition({ op: ours, a: v });
            if (c) cond[col] = c;
          }
        }
      }
    };
    walk(tags(db, 'table:filter')[0] || { children: [] }, false);
    return { range, hidden, ...(Object.keys(cond).length && { cond }) };
  }
  return null;
}
