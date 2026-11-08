// Protected sheets and ranges: the window that lists a sheet's protections and adds, changes or
// removes them (the rules are in protect.js; the server enforces them too).
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Modal } from '../../components/ui.jsx';
import { mayEdit, rangeBox } from './protect.js';

const newId = () => Math.random().toString(36).slice(2, 10);

/** Who may edit a protection, in words. */
export function whoMay(p, people, me, ownerId, ownerName) {
  if (p.warn) return 'Anyone who can edit, after a warning';
  const names = [ownerId === me ? 'you' : ownerName], seen = new Set([ownerId]);
  for (const id of [p.by, ...(p.editors || [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id === me ? 'you' : people.find((x) => x.user_id === id)?.name || 'someone');
  }
  return `Only ${names.join(', ')} can edit`;
}

/** list: the sheet's protections; onSave(nextList). */
export function ProtectDialog({ fileId, sheetName, list: list0, initial, me, ownerId, ownerName, canEdit, onSave, onClose }) {
  const [list, setList] = useState(list0 || []);
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState(null); // { id?, whole, range, desc, warn, editors }
  const [error, setError] = useState('');
  useEffect(() => { get(`/files/${fileId}/shares`).then((s) => setPeople(s.filter((x) => x.role === 'editor' && x.user_id !== ownerId))).catch(() => {}); }, [fileId, ownerId]);
  const save = (next) => { setList(next); onSave(next); };
  const start = (p) => { setError(''); setForm(p ? { ...p, whole: !p.range, range: p.range || initial || 'A1' } : { whole: false, range: initial || 'A1', desc: '', warn: false, editors: [] }); };
  const submit = () => {
    const range = form.whole ? null : String(form.range || '').trim().toUpperCase();
    if (!form.whole && !rangeBox(range)) { setError('Type a cell or a range, like B1 or A2:C10'); return; }
    const p = { id: form.id || newId(), range, editors: form.warn ? [] : form.editors, by: form.by || me, desc: form.desc.trim().slice(0, 200), ...(form.warn && { warn: true }) };
    save(form.id ? list.map((x) => (x.id === form.id ? p : x)) : [...list, p]);
    setForm(null);
  };
  const toggle = (id) => setForm((f) => ({ ...f, editors: f.editors.includes(id) ? f.editors.filter((x) => x !== id) : [...f.editors, id] }));
  return (
    <Modal title="Protected sheets and ranges" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Keep cells from being changed by mistake: only the people you choose can edit them, or everyone is warned first. Formulas elsewhere still read them.</p>
        {list.length ? (
          <ul className="names-list" aria-label="Protections">
            {list.map((p) => (
              <li key={p.id} className="row">
                <span className="grow">
                  <strong>{p.range || `Whole sheet “${sheetName}”`}</strong>{p.desc && <> · {p.desc}</>}
                  <br /><span className="muted small">{whoMay(p, people, me, ownerId, ownerName)}</span>
                </span>
                {canEdit && mayEdit(p, me, ownerId) && <>
                  <button type="button" className="link-btn small" aria-label={`Change ${p.range || 'whole sheet'} protection`} onClick={() => start(p)}>Change</button>
                  <button type="button" className="link-btn small" aria-label={`Remove ${p.range || 'whole sheet'} protection`} onClick={() => save(list.filter((x) => x.id !== p.id))}>Remove</button>
                </>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small" style={{ margin: 0 }}>Nothing on this sheet is protected.</p>}
        {canEdit && !form && <div><button type="button" className="btn" onClick={() => start(null)}>Add a protection</button></div>}
        {form && (
          <form className="stack-tight protect-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="row wrap">
              <label className="row"><input type="radio" name="what" checked={!form.whole} onChange={() => setForm({ ...form, whole: false })} /> Range</label>
              <label className="row"><input type="radio" name="what" checked={form.whole} onChange={() => setForm({ ...form, whole: true })} /> Whole sheet</label>
            </div>
            {!form.whole && <label className="field"><span>Cells</span><input value={form.range} onChange={(e) => setForm({ ...form, range: e.target.value })} placeholder="A1:C10" autoFocus /></label>}
            <label className="field"><span>Description (optional)</span><input value={form.desc} maxLength={200} onChange={(e) => setForm({ ...form, desc: e.target.value })} placeholder="Prices: ask Finance" /></label>
            <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small"><strong>Who can edit</strong></legend>
              <label className="row"><input type="radio" name="who" checked={!form.warn} onChange={() => setForm({ ...form, warn: false })} /> Only the owner, you, and people ticked here</label>
              {!form.warn && (people.length ? (
                <div className="protect-people" role="group" aria-label="People who can edit it">
                  {people.filter((x) => x.user_id !== me).map((x) => (
                    <label key={x.user_id} className="row"><input type="checkbox" checked={form.editors.includes(x.user_id)} onChange={() => toggle(x.user_id)} /> {x.name}</label>
                  ))}
                </div>
              ) : <p className="muted small" style={{ margin: '0 0 0 24px' }}>No one else has edit access to this file.</p>)}
              <label className="row"><input type="radio" name="who" checked={!!form.warn} onChange={() => setForm({ ...form, warn: true })} /> Anyone who can edit, after a warning</label>
            </fieldset>
            {error && <p className="error small" role="alert" style={{ margin: 0 }}>{error}</p>}
            <div className="row">
              <button type="submit" className="btn primary">{form.id ? 'Save' : 'Protect'}</button>
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
