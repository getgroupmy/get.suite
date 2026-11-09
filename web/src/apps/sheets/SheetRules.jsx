// The conditional formatting dialog: this sheet's rules, in the order they're tried, with a form to
// add or change one.
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { CONDITIONS, NEEDS_VALUE, STYLES, describeRule } from './condformat.js';
import { parseRange } from './charts.js';

const newId = () => Math.random().toString(36).slice(2, 10);

export function RulesDialog({ rules, defaultRange, onChange, onClose }) {
  const [editing, setEditing] = useState(rules.length ? null : { id: null, range: defaultRange, when: 'gt', value: '', value2: '', fill: STYLES[1][0], color: STYLES[1][1], bold: false });
  const save = (r) => {
    const clean = { ...r, range: r.range.toUpperCase().replace(/\s/g, ''), ...(NEEDS_VALUE.has(r.when) ? {} : { value: undefined, value2: undefined }), ...(r.when === 'between' ? {} : { value2: undefined }) };
    onChange(r.id ? rules.map((x) => (x.id === r.id ? clean : x)) : [...rules, { ...clean, id: newId() }]);
    setEditing(null);
  };
  const move = (i, d) => { const next = [...rules]; [next[i], next[i + d]] = [next[i + d], next[i]]; onChange(next); };
  return (
    <Modal title="Conditional formatting" onClose={onClose} wide>
      {editing ? <RuleForm rule={editing} onSave={save} onCancel={() => setEditing(null)} /> : (
        <div className="stack">
          {!rules.length && <p className="muted">No rules on this sheet yet.</p>}
          <ol className="rule-list">
            {rules.map((r, i) => (
              <li key={r.id}>
                <span className="rule-sample" style={{ background: r.fill || 'transparent', color: r.color || 'inherit', fontWeight: r.bold ? 700 : 400 }}>123</span>
                <span className="grow">{describeRule(r)}</span>
                <button type="button" className="icon-btn" aria-label={`Try earlier: ${describeRule(r)}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="icon-btn" aria-label={`Try later: ${describeRule(r)}`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="icon-btn" aria-label={`Change rule ${describeRule(r)}`} onClick={() => setEditing({ value2: '', ...r })}><Icon name="edit" size={16} /></button>
                <button type="button" className="icon-btn" aria-label={`Delete rule ${describeRule(r)}`} onClick={() => onChange(rules.filter((x) => x.id !== r.id))}><Icon name="trash" size={16} /></button>
              </li>
            ))}
          </ol>
          {rules.length > 1 && <p className="muted small">Rules are tried from the top; the first one that fits a cell colours it.</p>}
          <div className="row"><button type="button" className="btn primary" onClick={() => setEditing({ id: null, range: defaultRange, when: 'gt', value: '', value2: '', fill: STYLES[1][0], color: STYLES[1][1], bold: false })}><Icon name="plus" size={16} /> Add a rule</button></div>
        </div>
      )}
    </Modal>
  );
}

function RuleForm({ rule, onSave, onCancel }) {
  const [r, setR] = useState(rule);
  const set = (k) => (e) => setR({ ...r, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const okRange = !!parseRange(r.range);
  const needs = NEEDS_VALUE.has(r.when);
  const ok = okRange && (!needs || String(r.value ?? '').trim() !== '') && (!['top', 'bottom'].includes(r.when) || Number(r.value) >= 1) && (r.when !== 'between' || String(r.value2 ?? '').trim() !== '');
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(r); }}>
      <label className="field"><span>Apply to cells</span><input value={r.range} onChange={set('range')} aria-invalid={!okRange} placeholder="B2:B20" /></label>
      <div className="row wrap" style={{ gap: 10 }}>
        <label className="field"><span>When the value is</span>
          <select value={r.when} onChange={set('when')}>{CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        {needs && r.when === 'formula' && <label className="field grow"><span>Formula</span><input className="mono" value={r.value ?? ''} onChange={set('value')} placeholder="=$C2>100" /></label>}
        {needs && (r.when === 'top' || r.when === 'bottom') && <label className="field"><span>How many</span><input type="number" min={1} max={1000} value={r.value ?? ''} onChange={set('value')} /></label>}
        {needs && !['formula', 'top', 'bottom'].includes(r.when) && <label className="field"><span>{r.when === 'between' ? 'From' : 'Value'}</span><input value={r.value ?? ''} onChange={set('value')} /></label>}
        {r.when === 'between' && <label className="field"><span>To</span><input value={r.value2 ?? ''} onChange={set('value2')} /></label>}
      </div>
      {r.when === 'formula' && <p className="muted small" style={{ margin: 0 }}>Write it for the first cell of the range ({String(r.range || '').split(':')[0] || 'its top left cell'}); it moves along to each cell like a copied formula, and colours the cells where it's TRUE. Put $ before a column or row to keep it fixed: <code>=$C2&gt;100</code> colours a whole row by its C cell.</p>}
      <fieldset className="rule-styles">
        <legend className="muted small">Format</legend>
        {STYLES.map(([fill, color, name]) => (
          <button key={name} type="button" className={`rule-sample ${r.fill === fill ? 'on' : ''}`} aria-pressed={r.fill === fill} aria-label={name}
            style={{ background: fill, color, fontWeight: r.bold ? 700 : 400 }} onClick={() => setR({ ...r, fill, color })}>123</button>
        ))}
        <label className="check"><input type="checkbox" checked={!!r.bold} onChange={set('bold')} /> Bold</label>
      </fieldset>
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!ok}>{rule.id ? 'Save rule' : 'Add rule'}</button>
      </div>
    </form>
  );
}
