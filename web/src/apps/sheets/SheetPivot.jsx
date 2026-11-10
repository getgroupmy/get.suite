// The pivot table window: which column gives the rows (grouped by month, quarter or year for dates),
// which (optionally) the columns, what to show (one or more values), and a filter, shares of the total
// and the order of the rows.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { colName } from './formula.js';
import { FNS, GROUPS, valuesOf } from './pivot.js';

/**
 * headings: [{ c, label }] of the source table's columns. spec: { rows, cols, value, fn, values?, group?,
 * filter?: { col, hide }, show?, sort? } (absolute columns). table: the data as it shows (for the filter).
 */
export function PivotDialog({ headings, source, spec: spec0, table = [], editing, onSave, onClose }) {
  const [spec, setSpec] = useState(() => ({ ...spec0, values: spec0.values?.length ? spec0.values : [{ col: spec0.value ?? null, fn: spec0.fn || 'sum' }] }));
  const set = (k) => (e) => setSpec({ ...spec, [k]: e.target.value === '' ? null : (['group', 'show', 'sort'].includes(k) ? e.target.value : Number(e.target.value)) });
  const opt = (h) => <option key={h.c} value={h.c}>{h.label || `Column ${colName(h.c)}`}</option>;
  const setValue = (i, patch) => setSpec({ ...spec, values: spec.values.map((v, k) => (k === i ? { ...v, ...patch } : v)) });
  const several = spec.values.length > 1;
  // The filter: a column, and its values with a tick for each one to keep.
  const fcol = spec.filter?.col ?? null;
  const fvalues = fcol === null ? [] : valuesOf(table, fcol - spec.c1);
  const hidden = new Set(spec.filter?.hide || []);
  const toggle = (key) => { const h = new Set(hidden); h.has(key) ? h.delete(key) : h.add(key); setSpec({ ...spec, filter: { col: fcol, hide: [...h] } }); };
  const save = () => {
    const values = spec.values.slice(0, 5);
    onSave({ ...spec, values, value: values[0].col, fn: values[0].fn, cols: values.length > 1 ? null : spec.cols, ...(spec.filter && !spec.filter.hide?.length && { filter: null }) });
  };
  return (
    <Modal title={editing ? 'Edit pivot table' : 'Pivot table'} onClose={onClose} wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>{editing ? 'Save' : 'Create'}</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}>Summarises <strong>{source}</strong> on {editing ? 'this' : 'a new'} sheet, which updates by itself when the data changes (including rows added below).</p>
        <div className="row wrap">
          <label className="field"><span>Rows: one for each</span><select value={spec.rows} onChange={set('rows')}>{headings.map(opt)}</select></label>
          <label className="field"><span>Dates in it</span><select aria-label="Dates in it" value={spec.group || ''} onChange={set('group')}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <label className="field"><span>Columns: one for each (optional)</span>
          <select value={several ? '' : spec.cols ?? ''} disabled={several} onChange={set('cols')}><option value="">None</option>{headings.filter((h) => h.c !== spec.rows).map(opt)}</select></label>
        {several && <p className="muted small" style={{ margin: 0 }}>With several values side by side, there are no columns to split by.</p>}
        <fieldset className="stack pivot-values"><legend>What it adds up</legend>
          {spec.values.map((v, i) => (
            <div key={i} className="row wrap" style={{ alignItems: 'end' }}>
              <label className="field"><span>{i === 0 ? 'Show' : 'And'}</span>
                <select aria-label={i === 0 ? 'Values' : `Value ${i + 1}`} value={v.col ?? ''} onChange={(e) => setValue(i, { col: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Count of rows</option>{headings.map(opt)}</select></label>
              {v.col !== null && <label className="field"><span>Summarise by</span>
                <select aria-label={i === 0 ? 'Summarise by' : `Summarise value ${i + 1} by`} value={v.fn} onChange={(e) => setValue(i, { fn: e.target.value })}>{FNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
              {i > 0 && <button type="button" className="btn small" onClick={() => setSpec({ ...spec, values: spec.values.filter((_, k) => k !== i) })}>Remove</button>}
            </div>
          ))}
          {spec.values.length < 5 && <div><button type="button" className="btn small" onClick={() => setSpec({ ...spec, cols: null, values: [...spec.values, { col: spec.values[0].col, fn: 'count' }] })}>+ Add a value</button></div>}
        </fieldset>
        <div className="row wrap">
          <label className="field"><span>Show</span><select aria-label="Show as" value={spec.show || 'value'} onChange={set('show')}><option value="value">The values</option><option value="percent">Each as % of the grand total</option></select></label>
          <label className="field"><span>Order rows</span><select aria-label="Order rows" value={spec.sort || 'label'} onChange={set('sort')}><option value="label">By name</option><option value="desc">Largest value first</option><option value="asc">Smallest value first</option></select></label>
        </div>
        <fieldset className="stack"><legend>Filter</legend>
          <label className="field"><span>Only rows where</span>
            <select aria-label="Filter column" value={fcol ?? ''} onChange={(e) => setSpec({ ...spec, filter: e.target.value === '' ? null : { col: Number(e.target.value), hide: [] } })}><option value="">(no filter)</option>{headings.map(opt)}</select></label>
          {fcol !== null && <ul className="pivot-filter" aria-label="Rows to keep">
            {fvalues.map((f) => <li key={String(f.key)}><label className="check"><input type="checkbox" checked={!hidden.has(f.key)} onChange={() => toggle(f.key)} /> {String(f.key)} <span className="muted small">{f.count}</span></label></li>)}
          </ul>}
        </fieldset>
      </div>
    </Modal>
  );
}
