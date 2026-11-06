// Dropdowns and tick boxes: the dialog listing this sheet's ones, with a form to add or change one,
// and the little list of choices that opens from a dropdown cell.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { parseRange } from './charts.js';
import { parseChoices, describeValidation } from './validation.js';

const newId = () => Math.random().toString(36).slice(2, 10);

/** `existing(range)`: the distinct values already in those cells, to start a list from. */
export function ValidationDialog({ validations, defaultRange, existing, onChange, onClose }) {
  const fresh = () => ({ id: null, range: defaultRange, type: 'list', choices: existing(defaultRange).join('\n'), strict: true });
  const [editing, setEditing] = useState(validations.length ? null : fresh());
  const save = (v) => {
    const clean = { id: v.id || newId(), range: v.range.toUpperCase().replace(/\s/g, ''), type: v.type, ...(v.type === 'list' && { values: parseChoices(v.choices), strict: !!v.strict }) };
    onChange(v.id ? validations.map((x) => (x.id === v.id ? clean : x)) : [...validations, clean]);
    setEditing(null);
  };
  return (
    <Modal title="Dropdowns and tick boxes" onClose={onClose} wide>
      {editing ? <ValidationForm initial={editing} existing={existing} onSave={save} onCancel={() => (validations.length ? setEditing(null) : onClose())} /> : (
        <div className="stack">
          <ul className="rule-list">
            {validations.map((v) => (
              <li key={v.id}>
                <span className="rule-range">{v.range}</span>
                <span className="grow">{describeValidation(v)}</span>
                <button type="button" className="icon-btn" aria-label={`Change ${v.range}`} onClick={() => setEditing({ ...v, choices: (v.values || []).join('\n') })}><Icon name="edit" size={16} /></button>
                <button type="button" className="icon-btn" aria-label={`Remove ${v.range}`} onClick={() => onChange(validations.filter((x) => x.id !== v.id))}><Icon name="trash" size={16} /></button>
              </li>
            ))}
          </ul>
          <p className="muted small">Removing one keeps what's in the cells.</p>
          <div className="row"><button type="button" className="btn primary" onClick={() => setEditing(fresh())}><Icon name="plus" size={16} /> Add</button></div>
        </div>
      )}
    </Modal>
  );
}

function ValidationForm({ initial, existing, onSave, onCancel }) {
  const [v, setV] = useState(initial);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const okRange = !!parseRange(v.range);
  const choices = parseChoices(v.choices);
  const ok = okRange && (v.type === 'checkbox' || choices.length > 0);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(v); }}>
      <label className="field"><span>Cells</span><input value={v.range} onChange={set('range')} aria-invalid={!okRange} placeholder="B2:B20" /></label>
      <div className="seg" role="radiogroup" aria-label="Kind">
        {[['list', 'Dropdown'], ['checkbox', 'Tick box']].map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={v.type === k} className={v.type === k ? 'on' : ''} onClick={() => setV({ ...v, type: k })}>{l}</button>
        ))}
      </div>
      {v.type === 'list' ? <>
        <label className="field"><span>Choices (one per line, or separated by commas)</span>
          <textarea rows={6} value={v.choices} onChange={set('choices')} placeholder={'Open\nIn progress\nDone'} /></label>
        <div className="row wrap" style={{ gap: 12 }}>
          <span className="muted small grow">{choices.length} choice{choices.length === 1 ? '' : 's'}</span>
          {okRange && <button type="button" className="link-btn small" onClick={() => setV({ ...v, choices: existing(v.range).join('\n') })}>Use what's in the cells</button>}
        </div>
        <label className="check"><input type="checkbox" checked={!!v.strict} onChange={set('strict')} /> Only allow these choices</label>
      </> : <p className="muted small" style={{ margin: 0 }}>Each cell shows a box: ticked is TRUE, empty is FALSE. Formulas can count them, e.g. =COUNTIF(C2:C20, TRUE).</p>}
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ok}>{initial.id ? 'Save' : 'Add'}</button>
      </div>
    </form>
  );
}

/** The choices under a dropdown cell: arrow keys and Enter, or type to narrow; Escape closes. */
export function ChoicePicker({ anchor, values, current, onPick, onClose }) {
  const [filter, setFilter] = useState('');
  const [at, setAt] = useState(Math.max(0, values.findIndex((x) => x === current)));
  const box = useRef();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240;
    setPos({ left: Math.min(r.left, window.innerWidth - 230), ...(below ? { top: r.bottom + 2 } : { bottom: window.innerHeight - r.top + 2 }), minWidth: Math.max(160, r.width) });
  }, [anchor]);
  useEffect(() => {
    const away = (e) => { if (!box.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  const shown = values.filter((x) => x.toLowerCase().includes(filter.toLowerCase()));
  const pick = (x) => onPick(x);
  return (
    <div ref={box} className="choice-picker" style={pos || { visibility: 'hidden' }}>
      {values.length > 8 && <input autoFocus value={filter} placeholder="Find" aria-label="Find a choice" onChange={(e) => { setFilter(e.target.value); setAt(0); }}
        onKeyDown={(e) => keys(e)} />}
      <ul role="listbox" aria-label="Choices" tabIndex={-1} autoFocus={values.length <= 8} ref={(el) => { if (el && values.length <= 8) el.focus(); }} onKeyDown={(e) => keys(e)}>
        {current && <li role="option" aria-selected={false} className="clear" onMouseDown={(e) => { e.preventDefault(); pick(''); }}>Clear</li>}
        {shown.map((x, i) => (
          <li key={x} role="option" aria-selected={i === at} className={`${i === at ? 'on' : ''} ${x === current ? 'current' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(x); }}>
            {x === current && <span aria-hidden="true">✓ </span>}{x}
          </li>
        ))}
        {!shown.length && <li className="muted">No match</li>}
      </ul>
    </div>
  );
  function keys(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[at] !== undefined) pick(shown[at]); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); }
  }
}
