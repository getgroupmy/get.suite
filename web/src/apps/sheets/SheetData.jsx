// Data tools' windows: Remove duplicates and Split text to columns (the work is in data.js).
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
