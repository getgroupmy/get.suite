import { useEffect, useState } from 'react';
import { get, put, post } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Modal, useToast } from '../../components/ui.jsx';

const FIELD = { from: 'From', to: 'To or Cc', subject: 'Subject' };
const OP = { contains: 'contains', not_contains: "doesn't contain", is: 'is exactly' };
const NEW_FOLDER = '__new__';

export function describeRule(r) {
  const conds = r.conditions.map((c) => `${FIELD[c.field]} ${OP[c.op]} “${c.value}”`).join(r.match === 'any' ? ' or ' : ' and ');
  const a = r.actions;
  const acts = [
    a.delete && 'delete it',
    a.moveTo && `move to ${a.moveTo}`,
    a.markRead && 'mark as read',
    a.star && 'star it',
    a.forwardTo && `forward a copy to ${a.forwardTo}`,
  ].filter(Boolean).join(', ');
  return `If ${conds}: ${acts}`;
}

/** List, reorder, switch on/off, edit and delete filter rules. Saves on every change. */
export function FiltersDialog({ onClose, folders, onFoldersChanged, startWith }) {
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState(startWith ? { index: -1, rule: startWith } : null);
  useEffect(() => { get('/mail/rules').then(setRules).catch((e) => toast(e.message, 'error')); }, [toast]);

  async function save(next, msg) {
    try { setRules(await put('/mail/rules', { rules: next })); if (msg) toast(msg); return true; }
    catch (e) { toast(e.message, 'error'); return false; }
  }
  const move = (i, d) => { const n = [...rules]; [n[i], n[i + d]] = [n[i + d], n[i]]; save(n); };

  if (editing && rules) {
    return (
      <RuleEditor rule={editing.rule} isNew={editing.index === -1} folders={folders} onFoldersChanged={onFoldersChanged}
        onCancel={() => (startWith && editing.index === -1 ? onClose() : setEditing(null))}
        onSave={async (rule) => {
          const next = editing.index === -1 ? [...rules, rule] : rules.map((r, i) => (i === editing.index ? rule : r));
          if (await save(next, 'Filter saved')) { if (startWith && editing.index === -1) onClose(); else setEditing(null); }
        }} />
    );
  }

  return (
    <Modal wide title="Filters" onClose={onClose} footer={<button className="btn primary" onClick={() => setEditing({ index: -1, rule: null })}><Icon name="plus" size={18} /> New filter</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Filters run on the mail server as messages arrive, so they also apply to mail read on your phone. They run in this order.</p>
      {rules?.length === 0 && <p className="muted">No filters yet.</p>}
      <ul className="rule-list">
        {rules?.map((r, i) => (
          <li key={i} className={r.enabled ? '' : 'dim'}>
            <label className="check" title={r.enabled ? 'On' : 'Off'}>
              <input type="checkbox" aria-label={`Turn ${r.name} ${r.enabled ? 'off' : 'on'}`} checked={r.enabled}
                onChange={() => save(rules.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))} />
            </label>
            <div className="grow">
              <strong>{r.name}</strong>
              <div className="muted small">{describeRule(r)}{r.actions.stop || r.actions.delete ? '' : ' · then keep checking other filters'}</div>
            </div>
            <button className="icon-btn" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="icon-btn" aria-label={`Move ${r.name} down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ index: i, rule: r })}><Icon name="edit" size={18} /></button>
            <button className="icon-btn" aria-label={`Delete ${r.name}`} onClick={() => save(rules.filter((_, j) => j !== i), 'Filter deleted')}><Icon name="trash" size={18} /></button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function RuleEditor({ rule, isNew, folders, onFoldersChanged, onCancel, onSave }) {
  const blank = { name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: { stop: true } };
  const [r, setR] = useState(() => JSON.parse(JSON.stringify({ ...blank, ...(rule || {}) })));
  const [newFolder, setNewFolder] = useState('');
  const [error, setError] = useState('');
  const a = r.actions;
  const setA = (patch) => setR({ ...r, actions: { ...a, ...patch } });
  const setC = (i, patch) => setR({ ...r, conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const choosable = folders.filter((f) => !['\\Sent', '\\Drafts', '\\Trash'].includes(f.specialUse));
  const moveValue = a.moveTo === undefined || a.moveTo === null ? '' : choosable.some((f) => f.path === a.moveTo) ? a.moveTo : NEW_FOLDER;

  async function submit(e) {
    e.preventDefault();
    setError('');
    const out = { ...r, name: r.name.trim() || r.conditions.map((c) => c.value).filter(Boolean).join(', ').slice(0, 60) || 'Filter' };
    if (moveValue === NEW_FOLDER || (a.moveTo && !choosable.some((f) => f.path === a.moveTo))) {
      const name = (newFolder || a.moveTo || '').trim();
      if (!name) return setError('Name the new folder');
      try { await post('/mail/folders', { name }); onFoldersChanged?.(); }
      catch (err) { if (!/already exists/.test(err.message)) return setError(err.message); }
      out.actions = { ...out.actions, moveTo: name };
    }
    onSave(out);
  }

  return (
    <Modal wide title={isNew ? 'New filter' : 'Edit filter'} onClose={onCancel}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Name</span><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Newsletters" /></label>
        <fieldset className="rule-box">
          <legend>When a message arrives and
            <select aria-label="Match" value={r.match} onChange={(e) => setR({ ...r, match: e.target.value })}>
              <option value="all">all</option><option value="any">any</option>
            </select> of these are true</legend>
          {r.conditions.map((c, i) => (
            <div key={i} className="row wrap rule-cond">
              <select aria-label={`Condition ${i + 1} field`} value={c.field} onChange={(e) => setC(i, { field: e.target.value })}>
                {Object.entries(FIELD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select aria-label={`Condition ${i + 1} comparison`} value={c.op} onChange={(e) => setC(i, { op: e.target.value })}>
                {Object.entries(OP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input className="grow" aria-label={`Condition ${i + 1} value`} value={c.value} required onChange={(e) => setC(i, { value: e.target.value })}
                placeholder={c.field === 'subject' ? 'invoice' : 'name@company.com'} />
              {r.conditions.length > 1 && <button type="button" className="icon-btn" aria-label={`Remove condition ${i + 1}`} onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={16} /></button>}
            </div>
          ))}
          {r.conditions.length < 10 && <button type="button" className="link" onClick={() => setR({ ...r, conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}>+ Add condition</button>}
        </fieldset>
        <fieldset className="rule-box">
          <legend>Do this</legend>
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={!!a.moveTo || moveValue === NEW_FOLDER} disabled={a.delete}
              onChange={(e) => setA({ moveTo: e.target.checked ? (choosable.find((f) => f.specialUse !== '\\Inbox')?.path || '') : null })} /> Move to</label>
            {(a.moveTo !== null && a.moveTo !== undefined) && (
              <>
                <select aria-label="Folder" value={moveValue} onChange={(e) => setA({ moveTo: e.target.value === NEW_FOLDER ? '' : e.target.value })}>
                  {choosable.map((f) => <option key={f.path} value={f.path}>{f.name === f.path ? f.name : f.path}</option>)}
                  <option value={NEW_FOLDER}>New folder…</option>
                </select>
                {moveValue === NEW_FOLDER && <input aria-label="New folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="Folder name, e.g. Clients/Acme" />}
              </>
            )}
          </div>
          <label className="check"><input type="checkbox" checked={!!a.markRead} onChange={(e) => setA({ markRead: e.target.checked })} /> Mark as read</label>
          <label className="check"><input type="checkbox" checked={!!a.star} onChange={(e) => setA({ star: e.target.checked })} /> Star it</label>
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={a.forwardTo !== undefined && a.forwardTo !== null} onChange={(e) => setA({ forwardTo: e.target.checked ? '' : null })} /> Forward a copy to</label>
            {a.forwardTo !== undefined && a.forwardTo !== null && <input type="email" aria-label="Forward to" required value={a.forwardTo} onChange={(e) => setA({ forwardTo: e.target.value })} placeholder="name@company.com" />}
          </div>
          <label className="check"><input type="checkbox" checked={!!a.delete} onChange={(e) => setA({ delete: e.target.checked, ...(e.target.checked && { moveTo: null }) })} /> Delete it</label>
          <label className="check muted small"><input type="checkbox" checked={a.stop !== false} onChange={(e) => setA({ stop: e.target.checked })} /> Don't apply later filters to matching messages</label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary">Save filter</button></div>
      </form>
    </Modal>
  );
}
