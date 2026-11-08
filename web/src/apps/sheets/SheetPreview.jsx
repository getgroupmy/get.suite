// A read-only look at a spreadsheet's content (for version history): its values, sheet by sheet.
import { useMemo, useState } from 'react';
import { createEvaluator, display, colName, cellKey, parseRef } from './formula.js';

export function SheetPreview({ content }) {
  const sheets = content?.sheets || [];
  const [i, setI] = useState(0);
  const sheet = sheets[Math.min(i, sheets.length - 1)] || { cells: {} };
  const value = useMemo(() => createEvaluator(sheet.cells || {}, sheet.names), [sheet]);
  let rows = 0, cols = 0;
  for (const k of Object.keys(sheet.cells || {})) { const p = parseRef(k); if (p) { rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1); } }
  rows = Math.min(Math.max(rows, 5), 200); cols = Math.min(Math.max(cols, 3), 26);
  return (
    <div className="sheet-preview">
      {sheets.length > 1 && <div className="tabs">{sheets.map((s, n) => <button key={n} type="button" className={n === i ? 'on' : ''} onClick={() => setI(n)}>{s.name}</button>)}</div>}
      <table className="grid-preview">
        <thead><tr><th />{Array.from({ length: cols }, (_, c) => <th key={c}>{colName(c)}</th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, r) => (
          <tr key={r}><th>{r + 1}</th>{Array.from({ length: cols }, (_, c) => { const k = cellKey(c, r); const v = sheet.cells?.[k] === undefined ? null : value(k); return <td key={c} className={typeof v === 'number' ? 'num' : ''}>{display(v)}</td>; })}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}
