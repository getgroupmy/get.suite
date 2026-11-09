// The menu under a filter heading: sort the filtered rows by this column, and tick the values to
// show (with a search for long lists), or a condition the values must meet.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CONDITIONS, cleanCondition } from './filtercond.js';

export function FilterMenu({ anchor, column, values, hidden, cond, onApply, onSort, onClose, label }) {
  const [op, setOp] = useState(cond?.op || '');
  const [a, setA] = useState(cond?.a || '');
  const [b, setB] = useState(cond?.b || '');
  const args = CONDITIONS.find((c) => c.op === op)?.args || 0;
  const [show, setShow] = useState(() => new Set(values.map((v) => v.label).filter((l) => !hidden.includes(l))));
  const [find, setFind] = useState('');
  const box = useRef();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 270)), top: Math.min(r.bottom + 2, window.innerHeight - 380) });
  }, [anchor]);
  useEffect(() => {
    const away = (e) => { if (!box.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [onClose]);
  const shown = values.filter((v) => (v.label || '(Blanks)').toLowerCase().includes(find.toLowerCase()));
  const toggle = (l) => { const n = new Set(show); n.has(l) ? n.delete(l) : n.add(l); setShow(n); };
  return (
    <div ref={box} className="filter-menu" role="dialog" aria-label={label || `Filter column ${column}`} style={pos || { visibility: 'hidden' }}>
      {onSort && <div className="filter-sort">
        <button type="button" className="link-btn" onClick={() => onSort(false)}>Sort A → Z</button>
        <button type="button" className="link-btn" onClick={() => onSort(true)}>Sort Z → A</button>
      </div>}
      {onSort && <fieldset className="filter-cond">
        <legend className="small muted">Filter by condition</legend>
        <select value={op} onChange={(e) => setOp(e.target.value)} aria-label="Condition">
          <option value="">None</option>
          {CONDITIONS.map((c) => <option key={c.op} value={c.op}>{c.label}</option>)}
        </select>
        {args >= 1 && <input value={a} onChange={(e) => setA(e.target.value)} placeholder="Value" aria-label="Condition value" />}
        {args === 2 && <input value={b} onChange={(e) => setB(e.target.value)} placeholder="and" aria-label="Second value" />}
      </fieldset>}
      <input type="search" autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search values" aria-label="Search values" />
      <div className="row small" style={{ gap: 10 }}>
        <button type="button" className="link-btn small" onClick={() => setShow(new Set(values.map((v) => v.label)))}>Select all</button>
        <button type="button" className="link-btn small" onClick={() => setShow(new Set())}>Clear</button>
      </div>
      <ul className="filter-values" aria-label="Values to show">
        {shown.map((v) => (
          <li key={v.label}><label className="check">
            <input type="checkbox" checked={show.has(v.label)} onChange={() => toggle(v.label)} />
            <span className={`grow ellipsis ${v.label ? '' : 'muted'}`}>{v.label || '(Blanks)'}</span><span className="muted small">{v.count}</span>
          </label></li>
        ))}
        {!shown.length && <li className="muted small">No match</li>}
      </ul>
      <div className="row end">
        <button type="button" className="btn small" onClick={onClose}>Cancel</button>
        <button type="button" className="btn small primary" onClick={() => onApply(values.map((v) => v.label).filter((l) => !show.has(l)), cleanCondition({ op, a, b }))}>OK</button>
      </div>
    </div>
  );
}
