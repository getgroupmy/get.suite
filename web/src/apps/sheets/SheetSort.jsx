// The Sort dialog: which cells, by which column, which way, and whether the top row is headings.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { colName, cellKey } from './formula.js';
import { parseRange, rangeText } from './charts.js';

export function SortDialog({ initial, header: headerGuess, value, onSort, onClose }) {
  const [text, setText] = useState(rangeText(initial.range));
  const [header, setHeader] = useState(headerGuess);
  const [by, setBy] = useState(initial.by);
  const [desc, setDesc] = useState(false);
  const g = parseRange(text);
  const cols = g ? Array.from({ length: Math.min(g.c2 - g.c1 + 1, 200) }, (_, i) => g.c1 + i) : [];
  const col = g && by >= g.c1 && by <= g.c2 ? by : g?.c1;
  const nameOf = (c) => { const h = header && g ? value(cellKey(c, g.r1)) : null; return h !== null && h !== '' && h !== undefined ? `${colName(c)} (${h})` : `Column ${colName(c)}`; };
  const ok = g && g.r2 - g.r1 + 1 - (header ? 1 : 0) > 1;
  const go = (e) => { e?.preventDefault(); if (ok) { onSort({ range: g, by: col, desc, header }); onClose(); } };
  return (
    <Modal title="Sort range" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!ok} onClick={go}>Sort</button></>}>
      <form className="stack" onSubmit={go}>
        <label className="field"><span>Cells</span><input value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!g} /></label>
        <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> The first row is headings (it stays at the top)</label>
        <label className="field"><span>Sort by</span>
          <select value={col ?? ''} onChange={(e) => setBy(Number(e.target.value))} disabled={!g}>{cols.map((c) => <option key={c} value={c}>{nameOf(c)}</option>)}</select>
        </label>
        <fieldset className="chart-types">
          <legend className="sr-only">Order</legend>
          <label className={!desc ? 'on' : ''}><input type="radio" name="sort-order" checked={!desc} onChange={() => setDesc(false)} />A → Z, smallest first</label>
          <label className={desc ? 'on' : ''}><input type="radio" name="sort-order" checked={desc} onChange={() => setDesc(true)} />Z → A, largest first</label>
        </fieldset>
        {!g && <p className="error small">Choose cells like A1:D20</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
