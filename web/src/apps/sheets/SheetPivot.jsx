// The pivot table window: which column gives the rows, which (optionally) the columns, and what to show.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { colName } from './formula.js';
import { FNS } from './pivot.js';

/** headings: [{ c, label }] of the source table's columns. spec: { rows, cols, value, fn } (absolute columns). */
export function PivotDialog({ headings, source, spec: spec0, editing, onSave, onClose }) {
  const [spec, setSpec] = useState(spec0);
  const set = (k) => (e) => setSpec({ ...spec, [k]: e.target.value === '' ? null : (k === 'fn' ? e.target.value : Number(e.target.value)) });
  const opt = (h) => <option key={h.c} value={h.c}>{h.label || `Column ${colName(h.c)}`}</option>;
  return (
    <Modal title={editing ? 'Edit pivot table' : 'Pivot table'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onSave(spec)}>{editing ? 'Save' : 'Create'}</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}>Summarises <strong>{source}</strong> on {editing ? 'this' : 'a new'} sheet, which updates by itself when the data changes (including rows added below).</p>
        <label className="field"><span>Rows: one for each</span><select value={spec.rows} onChange={set('rows')}>{headings.map(opt)}</select></label>
        <label className="field"><span>Columns: one for each (optional)</span><select value={spec.cols ?? ''} onChange={set('cols')}><option value="">None</option>{headings.filter((h) => h.c !== spec.rows).map(opt)}</select></label>
        <div className="row wrap">
          <label className="field"><span>Values</span><select value={spec.value ?? ''} onChange={set('value')}><option value="">Count of rows</option>{headings.map(opt)}</select></label>
          {spec.value !== null && <label className="field"><span>Summarise by</span><select value={spec.fn} onChange={set('fn')}>{FNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        </div>
      </div>
    </Modal>
  );
}
