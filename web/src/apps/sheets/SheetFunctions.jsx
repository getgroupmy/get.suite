// Named functions: the window that lists, adds, changes and removes the spreadsheet's own functions
// (the rules are in ownfuncs.js). They're used like any function: =WITHTAX(B2).
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { functionProblem, splitParams, cleanFunction, MAX_FUNCTIONS } from './ownfuncs.js';

const EMPTY = { name: '', params: '', body: '', description: '' };

/** functions: [{ name, params, body, description }]; onSave(next). */
export function FunctionsDialog({ functions: initial, canEdit, onSave, onClose }) {
  const [list, setList] = useState(initial || []);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // the name of the one being changed
  const [tried, setTried] = useState(false);
  const draft = { name: form.name, params: splitParams(form.params), body: form.body, description: form.description };
  const problem = functionProblem(draft, list, editing) || (!editing && list.length >= MAX_FUNCTIONS ? `At most ${MAX_FUNCTIONS} functions` : null);
  const save = (next) => { setList(next); onSave(next); };
  const add = () => {
    setTried(true);
    if (problem) return;
    const f = cleanFunction(draft);
    save(editing ? list.map((x) => (x.name === editing ? f : x)) : [...list, f]);
    setForm(EMPTY); setEditing(null); setTried(false);
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title="Named functions" wide onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Write a formula once and use it in any cell of this spreadsheet like a built-in function: <code>WITHTAX(amount)</code> = <code>amount * 1.2</code>, then <code>=WITHTAX(B2)</code>. Its arguments are names you use in its formula.</p>
        {list.length ? (
          <ul className="names-list" aria-label="Functions">
            {list.map((f) => (
              <li key={f.name} className="row">
                <span className="grow"><code>{f.name}({f.params.join(', ')})</code> = <code>{f.body}</code>{f.description && <span className="muted small"> — {f.description}</span>}</span>
                {canEdit && <>
                  <button type="button" className="btn small" aria-label={`Change ${f.name}`} onClick={() => { setEditing(f.name); setForm({ name: f.name, params: f.params.join(', '), body: `=${f.body}`, description: f.description || '' }); }}>Change</button>
                  <button type="button" className="btn small" aria-label={`Remove ${f.name}`} onClick={() => { save(list.filter((x) => x.name !== f.name)); if (editing === f.name) { setEditing(null); setForm(EMPTY); } }}>Remove</button>
                </>}
              </li>
            ))}
          </ul>
        ) : <p className="muted">No functions yet.</p>}
        {canEdit && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <strong>{editing ? `Change ${editing}` : 'New function'}</strong>
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="field"><span>Name</span><input value={form.name} onChange={set('name')} placeholder="WITHTAX" /></label>
              <label className="field grow"><span>Arguments (separated by commas)</span><input value={form.params} onChange={set('params')} placeholder="amount" /></label>
            </div>
            <label className="field"><span>Formula</span><input value={form.body} onChange={set('body')} placeholder="=amount * 1.2" spellCheck={false} /></label>
            <label className="field"><span>Description (shown while typing it)</span><input value={form.description} maxLength={200} onChange={set('description')} placeholder="Adds 20% sales tax" /></label>
            {tried && problem && <p className="error small" role="alert" style={{ margin: 0 }}>{problem}</p>}
            <div className="row end" style={{ gap: 8 }}>
              {editing && <button type="button" className="btn" onClick={() => { setEditing(null); setForm(EMPTY); setTried(false); }}>Cancel change</button>}
              <button type="submit" className="btn primary">{editing ? 'Save function' : 'Add function'}</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
