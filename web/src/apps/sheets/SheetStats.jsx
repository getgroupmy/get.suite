// The Column stats window: a quick summary of one column, with arrows to look at the next one.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { colName, cellKey } from './formula.js';
import { columnStats } from './colstats.js';

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function ColumnStatsDialog({ value, startCol, lastRow, lastCol, onClose }) {
  const [c, setC] = useState(startCol);
  const first = value(cellKey(c, 0));
  const [header, setHeader] = useState(typeof first === 'string' && first !== '');
  const s = columnStats(value, c, 0, Math.max(0, lastRow), { header });
  const name = header && typeof first === 'string' && first ? `${colName(c)} · ${first}` : colName(c);
  const most = s.frequent[0]?.count || 1;
  return (
    <Modal title="Column stats" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <div className="stack col-stats">
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="icon-btn" aria-label="Previous column" disabled={c === 0} onClick={() => setC(c - 1)}>‹</button>
          <strong className="grow" aria-live="polite">Column {name}</strong>
          <button type="button" className="icon-btn" aria-label="Next column" disabled={c >= lastCol} onClick={() => setC(c + 1)}>›</button>
        </div>
        <label className="check small"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> The first row is a heading</label>
        <dl className="stats-grid" aria-label="Counts">
          <div><dt>Filled</dt><dd>{fmt(s.filled)}</dd></div>
          <div><dt>Empty</dt><dd>{fmt(s.empty)}</dd></div>
          <div><dt>Different values</dt><dd>{fmt(s.unique)}</dd></div>
        </dl>
        {s.numbers && (
          <dl className="stats-grid" aria-label="Numbers">
            <div><dt>Sum</dt><dd>{fmt(s.numbers.sum)}</dd></div>
            <div><dt>Average</dt><dd>{fmt(s.numbers.average)}</dd></div>
            <div><dt>Median</dt><dd>{fmt(s.numbers.median)}</dd></div>
            <div><dt>Smallest</dt><dd>{fmt(s.numbers.min)}</dd></div>
            <div><dt>Largest</dt><dd>{fmt(s.numbers.max)}</dd></div>
            <div><dt>Numbers</dt><dd>{fmt(s.numbers.count)}</dd></div>
          </dl>
        )}
        {s.frequent.length > 0 && <>
          <div className="small muted">Most frequent</div>
          <ul className="stats-freq" aria-label="Most frequent values">
            {s.frequent.map((f) => (
              <li key={f.label}>
                <span className="ellipsis" title={f.label}>{f.label}</span>
                <span className="bar" style={{ width: `${Math.max(4, (f.count / most) * 100)}%` }} aria-hidden="true" />
                <span className="muted small">{f.count}</span>
              </li>
            ))}
          </ul>
        </>}
        {!s.filled && <p className="muted">This column is empty.</p>}
      </div>
    </Modal>
  );
}
