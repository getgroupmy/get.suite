// Named ranges: the window that lists, adds, renames and removes them (the rules are in names.js).
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { nameProblem, cleanTarget } from './names.js';

/** names: { Tax: 'B1' }; onSave(nextNames); onGo(target). */
export function NamesDialog({ names: names0, initial, canEdit, onSave, onGo, onClose }) {
  const [names, setNames] = useState(names0 || {});
  const [name, setName] = useState('');
  const [target, setTarget] = useState(initial || '');
  const [editing, setEditing] = useState(null); // the name being changed
  const [tried, setTried] = useState(false);
  const clean = cleanTarget(target);
  const problem = nameProblem(name, names, editing) || (!clean ? 'Type a cell or a range, like B1 or A2:A10' : null);
  const save = (next) => { setNames(next); onSave(next); };
  const add = () => {
    setTried(true);
    if (problem) return;
    const next = { ...names };
    if (editing) delete next[editing];
    next[name.trim()] = clean;
    save(next);
    setName(''); setTarget(initial || ''); setEditing(null); setTried(false);
  };
  const list = Object.entries(names).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Modal title="Named ranges" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Give cells a name and use it in formulas instead of the address: <code>=SUM(Sales)*Tax</code>. Type a name in the box left of the formula bar to go to it.</p>
        {list.length ? (
          <ul className="names-list" aria-label="Named ranges">
            {list.map(([n, t]) => (
              <li key={n} className="row">
                <strong className="grow">{n}</strong>
                <code>{t}</code>
                <button type="button" className="link-btn small" onClick={() => onGo(t)} aria-label={`Go to ${n}`}>Go to</button>
                {canEdit && <button type="button" className="link-btn small" aria-label={`Change ${n}`} onClick={() => { setEditing(n); setName(n); setTarget(t); }}>Change</button>}
                {canEdit && <button type="button" className="link-btn small" aria-label={`Remove ${n}`} onClick={() => { const next = { ...names }; delete next[n]; save(next); }}>Remove</button>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small" style={{ margin: 0 }}>No named ranges on this sheet yet.</p>}
        {canEdit && (
          <form className="stack-tight" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <div className="row wrap">
              <label className="field grow"><span>Name</span><input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="Sales" autoFocus /></label>
              <label className="field grow"><span>Cells</span><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="A2:A10" /></label>
            </div>
            {tried && problem && <p className="error small" role="alert" style={{ margin: 0 }}>{problem}</p>}
            <div className="row">
              <button type="submit" className="btn primary">{editing ? 'Save' : 'Add'}</button>
              {editing && <button type="button" className="btn" onClick={() => { setEditing(null); setName(''); setTarget(initial || ''); }}>Cancel</button>}
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
