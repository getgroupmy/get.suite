// Dropdowns and tick boxes: the dialog listing this sheet's ones, with a form to add or change one,
// and the little list of choices that opens from a dropdown cell.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { parseRange } from './charts.js';
import { parseChoices, describeValidation, cleanSource, cleanColours, CHIP_COLOURS, RULE_KINDS, RULE_OPS, WITH_OP } from './validation.js';

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * `existing(range)`: the distinct values already in those cells, to start a list from.
 * `resolve(source)`: the choices a range such as "Lists!A2:A20" gives now.
 */
export function ValidationDialog({ validations, defaultRange, existing, resolve, onChange, onClose }) {
  const fresh = () => ({ id: null, range: defaultRange, type: 'list', from: 'typed', choices: existing(defaultRange).join('\n'), source: '', strict: true });
  const [editing, setEditing] = useState(validations.length ? null : fresh());
  const save = (v) => {
    const fromRange = v.from === 'range';
    const values = fromRange ? [] : parseChoices(v.choices);
    const colors = cleanColours(v.colors, fromRange ? resolve(v.source) : values);
    const list = fromRange ? { source: cleanSource(v.source), strict: !!v.strict } : { values, strict: !!v.strict };
    const check = v.check || {};
    const rule = { check: { kind: check.kind || 'number', ...(WITH_OP.has(check.kind || 'number') && { op: check.op || 'between', a: String(check.a ?? '').trim(), ...(/between/i.test(check.op || 'between') && { b: String(check.b ?? '').trim() }) }), ...(check.kind === 'formula' && { a: String(check.a ?? '').trim() }) },
      strict: !!v.strict, ...(String(v.message || '').trim() && { message: String(v.message).trim().slice(0, 200) }) };
    const clean = { id: v.id || newId(), range: v.range.toUpperCase().replace(/\s/g, ''), type: v.type, ...(v.type === 'list' && { ...list, ...(colors && { colors }) }), ...(v.type === 'rule' && rule) };
    onChange(v.id ? validations.map((x) => (x.id === v.id ? clean : x)) : [...validations, clean]);
    setEditing(null);
  };
  return (
    <Modal title="Data validation" onClose={onClose} wide>
      {editing ? <ValidationForm initial={editing} existing={existing} resolve={resolve} onSave={save} onCancel={() => (validations.length ? setEditing(null) : onClose())} /> : (
        <div className="stack">
          <ul className="rule-list">
            {validations.map((v) => (
              <li key={v.id}>
                <span className="rule-range">{v.range}</span>
                <span className="grow">{describeValidation(v)}</span>
                <button type="button" className="icon-btn" aria-label={`Change ${v.range}`} onClick={() => setEditing({ ...v, from: v.source ? 'range' : 'typed', source: v.source || '', choices: (v.values || []).join('\n') })}><Icon name="edit" size={16} /></button>
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

function ValidationForm({ initial, existing, resolve, onSave, onCancel }) {
  const [v, setV] = useState(initial);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const okRange = !!parseRange(v.range);
  const fromRange = v.from === 'range';
  const okSource = !fromRange || !!cleanSource(v.source);
  const choices = fromRange ? (okSource ? resolve(v.source) : []) : parseChoices(v.choices);
  const check = v.check || { kind: 'number', op: 'between' };
  const setCheck = (k) => (e) => setV({ ...v, check: { ...check, [k]: e.target.value } });
  const needsA = v.type === 'rule' && (WITH_OP.has(check.kind) || check.kind === 'formula');
  const needsB = v.type === 'rule' && WITH_OP.has(check.kind) && /between/i.test(check.op || 'between');
  const okRule = v.type !== 'rule' || ((!needsA || String(check.a ?? '').trim() !== '') && (!needsB || String(check.b ?? '').trim() !== ''));
  const ok = okRange && okRule && (v.type !== 'list' || (okSource && (fromRange || choices.length > 0)));
  const limitType = check.kind === 'date' ? 'date' : check.kind === 'formula' ? 'text' : 'number';
  const colourOf = (x) => Object.entries(v.colors || {}).find(([k]) => k.toLowerCase() === x.toLowerCase())?.[1] || '';
  const setColour = (x, hex) => {
    const rest = Object.fromEntries(Object.entries(v.colors || {}).filter(([k]) => k.toLowerCase() !== x.toLowerCase()));
    setV({ ...v, colors: hex ? { ...rest, [x]: hex } : rest });
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(v); }}>
      <label className="field"><span>Cells</span><input value={v.range} onChange={set('range')} aria-invalid={!okRange} placeholder="B2:B20" /></label>
      <div className="seg" role="radiogroup" aria-label="Kind">
        {[['list', 'Dropdown'], ['checkbox', 'Tick box'], ['rule', 'Rule']].map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={v.type === k} className={v.type === k ? 'on' : ''} onClick={() => setV({ ...v, type: k, ...(k === 'rule' && !v.check && { check: { kind: 'number', op: 'between', a: '', b: '' }, strict: true }) })}>{l}</button>
        ))}
      </div>
      {v.type === 'list' ? <>
        <div className="seg" role="radiogroup" aria-label="Where the choices come from">
          {[['typed', 'A list of items'], ['range', 'A range of cells']].map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={(v.from || 'typed') === k} className={(v.from || 'typed') === k ? 'on' : ''} onClick={() => setV({ ...v, from: k })}>{l}</button>
          ))}
        </div>
        {fromRange ? <>
          <label className="field"><span>Choices from the cells</span>
            <input value={v.source} onChange={set('source')} aria-invalid={!!v.source && !okSource} placeholder="Lists!A2:A20" /></label>
          <p className="muted small" style={{ margin: 0 }}>The dropdown follows those cells: change the list there and every dropdown changes with it. Another tab is written like Lists!A2:A20.</p>
        </> : <label className="field"><span>Choices (one per line, or separated by commas)</span>
          <textarea rows={6} value={v.choices} onChange={set('choices')} placeholder={'Open\nIn progress\nDone'} /></label>}
        <div className="row wrap" style={{ gap: 12 }}>
          <span className="muted small grow" data-choice-count>{choices.length} choice{choices.length === 1 ? '' : 's'}{fromRange && okSource && !choices.length ? ' (those cells are empty)' : ''}</span>
          {okRange && !fromRange && <button type="button" className="link-btn small" onClick={() => setV({ ...v, choices: existing(v.range).join('\n') })}>Use what's in the cells</button>}
        </div>
        {choices.length > 0 && (
          <details className="choice-colours" open={Object.keys(v.colors || {}).length > 0}>
            <summary className="small">Colours</summary>
            <ul>
              {choices.slice(0, 30).map((x) => (
                <li key={x} className="row" style={{ gap: 8 }}>
                  <span className="cell-chip" style={{ background: colourOf(x) || 'transparent' }}>{x}</span>
                  <select className="grow" value={colourOf(x)} onChange={(e) => setColour(x, e.target.value)} aria-label={`Colour for ${x}`}>
                    <option value="">No colour</option>
                    {CHIP_COLOURS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
                  </select>
                </li>
              ))}
            </ul>
            {choices.length > 30 && <p className="muted small">The first 30 choices can have colours here.</p>}
          </details>
        )}
        <label className="check"><input type="checkbox" checked={!!v.strict} onChange={set('strict')} /> Only allow these choices</label>
      </> : v.type === 'rule' ? <>
        <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <label className="field"><span>Allow</span>
            <select value={check.kind} onChange={(e) => setV({ ...v, check: { ...check, kind: e.target.value, a: '', b: '' } })}>{RULE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {WITH_OP.has(check.kind) && <label className="field"><span>That is</span>
            <select value={check.op || 'between'} onChange={setCheck('op')}>{RULE_OPS.map(([k, l]) => <option key={k} value={k}>{check.kind === 'date' ? ({ gt: 'after', lt: 'before', gte: 'on or after', lte: 'on or before', eq: 'on', ne: 'not on' }[k] || l) : l}</option>)}</select></label>}
          {needsA && <label className={`field ${check.kind === 'formula' ? 'grow' : ''}`}><span>{check.kind === 'formula' ? 'Formula' : needsB ? 'From' : 'Value'}</span>
            <input type={limitType} className={check.kind === 'formula' ? 'mono' : ''} value={check.a ?? ''} onChange={setCheck('a')} placeholder={check.kind === 'formula' ? '=B2<=C2' : ''} /></label>}
          {needsB && <label className="field"><span>To</span><input type={limitType} value={check.b ?? ''} onChange={setCheck('b')} /></label>}
        </div>
        {check.kind === 'length' && <p className="muted small" style={{ margin: 0 }}>How many characters the text has.</p>}
        {check.kind === 'formula' && <p className="muted small" style={{ margin: 0 }}>Written for the first cell ({String(v.range || '').split(':')[0]}) and moved along to the others, like a copied formula. Cells where it isn't TRUE are marked in red.</p>}
        <label className="field"><span>Message when a value doesn't fit (optional)</span>
          <input value={v.message || ''} maxLength={200} onChange={set('message')} placeholder="e.g. A quantity from 1 to 99" /></label>
        {check.kind !== 'formula' ? (
          <fieldset className="stack-tight">
            <legend className="muted small">When something else is typed</legend>
            <label className="check"><input type="radio" name="strict" checked={!!v.strict} onChange={() => setV({ ...v, strict: true })} /> Refuse it</label>
            <label className="check"><input type="radio" name="strict" checked={!v.strict} onChange={() => setV({ ...v, strict: false })} /> Keep it, with a warning, and mark the cell</label>
          </fieldset>
        ) : null}
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
