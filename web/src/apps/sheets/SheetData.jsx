// Data tools' windows: Remove duplicates, Split text to columns and Smart fill (the work is in data.js and smartfill.js).
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { colName } from './formula.js';
import { SEPARATORS } from './data.js';

const rangeText = (g) => `${colName(g.c1)}${g.r1 + 1}:${colName(g.c2)}${g.r2 + 1}`;

/** Remove rows that repeat an earlier one in the range (all its columns compared). */
export function DedupeDialog({ range, header: header0, onRun, onClose }) {
  const [header, setHeader] = useState(header0);
  return (
    <Modal title="Remove duplicates" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onRun({ header })}>Remove duplicates</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}>Rows in <strong>{rangeText(range)}</strong> that repeat an earlier row (the same in every column, ignoring capitals and spaces at the ends) are removed, and the rest close up. Undo brings them back.</p>
        <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> The first row is headings</label>
      </div>
    </Modal>
  );
}

/** Split the text of a column into the columns to its right. */
export function SplitDialog({ range, onRun, onClose }) {
  const [sep, setSep] = useState('auto');
  const [custom, setCustom] = useState('');
  const use = sep === 'custom' ? custom : sep;
  return (
    <Modal title="Split text to columns" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!use} onClick={() => onRun({ sep: use })}>Split</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}>The text in <strong>{colName(range.c1)}{range.r1 + 1}:{colName(range.c1)}{range.r2 + 1}</strong> is split into the columns to its right (what's there is written over; Undo brings it back). Formulas and numbers stay as they are.</p>
        <label className="field"><span>Split at</span>
          <select value={sep} onChange={(e) => setSep(e.target.value)} aria-label="Split at">
            {SEPARATORS.map(([v, label]) => <option key={label} value={v}>{label}</option>)}
            <option value="custom">Something else…</option>
          </select></label>
        {sep === 'custom' && <label className="field"><span>Text to split at</span><input autoFocus maxLength={10} value={custom} onChange={(e) => setCustom(e.target.value)} /></label>}
      </div>
    </Modal>
  );
}

/** Smart fill: the pattern learnt from the column's examples, and what it would fill in, before it does. */
export function SmartFillDialog({ col, plan, onRun, onClose }) {
  const shown = plan.fills.slice(0, 5);
  return (
    <Modal title="Smart fill" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" autoFocus onClick={onRun}>Fill {plan.fills.length} cell{plan.fills.length === 1 ? '' : 's'}</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}>From your {plan.examples === 1 ? 'example' : `${plan.examples} examples`} in column {col}, each empty cell gets: <strong>{plan.describe}</strong>. Check a few below; Undo takes it all back.</p>
        <table className="files" aria-label="What Smart fill puts in">
          <thead><tr><th>Row</th><th>From</th><th>Fills in</th></tr></thead>
          <tbody>{shown.map((f) => <tr key={f.r}><td>{f.r + 1}</td><td className="muted">{f.from}</td><td><strong>{f.v}</strong></td></tr>)}</tbody>
        </table>
        {plan.fills.length > shown.length && <p className="muted small" style={{ margin: 0 }}>and {plan.fills.length - shown.length} more</p>}
      </div>
    </Modal>
  );
}
