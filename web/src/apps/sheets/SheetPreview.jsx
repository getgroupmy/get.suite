// A read-only look at a spreadsheet's content (for version history): its values, sheet by sheet.
import { useMemo, useState } from 'react';
import { bookEvaluator, display, colName, cellKey, parseRef } from './formula.js';
import { sheetChanges, changeTotals } from './sheetdiff.js';

export function SheetPreview({ content }) {
  const sheets = content?.sheets || [];
  const [i, setI] = useState(0);
  const sheet = sheets[Math.min(i, sheets.length - 1)] || { cells: {} };
  const value = useMemo(() => bookEvaluator(sheets, Math.min(i, sheets.length - 1)), [sheets, i]);
  let rows = 0, cols = 0;
  for (const k of Object.keys(sheet.cells || {})) { const p = parseRef(k); if (p) { rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1); } }
  rows = Math.min(Math.max(rows, 5), 200); cols = Math.min(Math.max(cols, 3), 26);
  return (
    <div className="sheet-preview">
      {sheets.length > 1 && <div className="tabs">{sheets.map((s, n) => <button key={n} type="button" className={n === i ? 'on' : ''} onClick={() => setI(n)}>{s.name}</button>)}</div>}
      <table className="grid-preview">
        <thead><tr><th />{Array.from({ length: cols }, (_, c) => <th key={c}>{colName(c)}</th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, r) => (
          <tr key={r}><th>{r + 1}</th>{Array.from({ length: cols }, (_, c) => { const k = cellKey(c, r); const v = value(k); return <td key={c} className={typeof v === 'number' ? 'num' : ''}>{display(v)}</td>; })}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** What changed since an earlier version: each sheet's cells typed in, changed or cleared. */
export function SheetChanges({ before, after }) {
  const changes = useMemo(() => sheetChanges(before, after), [before, after]);
  const totals = changeTotals(changes);
  const shown = changes.filter((s) => s.status !== 'same' || s.cells.length);
  const text = (v) => (v === '' ? <span className="muted">(empty)</span> : v);
  return (
    <div className="sheet-changes">
      <p className="muted small changes-summary">{shown.length ? `Since then: ${totals.cells} cell${totals.cells === 1 ? '' : 's'} changed${totals.sheets ? `, ${totals.sheets} sheet${totals.sheets === 1 ? '' : 's'} added, renamed or deleted` : ''}.` : 'No changes since then.'}</p>
      {shown.map((s) => (
        <section key={`${s.status}-${s.name}`} aria-label={`Changes in ${s.name}`}>
          <h4 style={{ margin: '12px 0 4px' }}>{s.name}
            {s.status === 'added' && <span className="pill change-pill-add"> new sheet</span>}
            {s.status === 'removed' && <span className="pill change-pill-del"> deleted</span>}
            {s.status === 'renamed' && <span className="muted small"> (was {s.was})</span>}</h4>
          {s.status !== 'removed' && s.cells.length > 0 && (
            <table className="grid-preview changes-table">
              <thead><tr><th>Cell</th><th>Then</th><th>Now</th></tr></thead>
              <tbody>{s.cells.slice(0, 300).map((c) => (
                <tr key={c.key} className={`change-${c.kind}`}><th>{c.key}</th><td>{c.kind === 'add' ? text('') : <del>{c.was}</del>}</td><td>{c.kind === 'del' ? text('') : <ins>{c.now}</ins>}</td></tr>
              ))}</tbody>
            </table>
          )}
          {s.cells.length > 300 && <p className="muted small">…and {s.cells.length - 300} more.</p>}
        </section>
      ))}
    </div>
  );
}
