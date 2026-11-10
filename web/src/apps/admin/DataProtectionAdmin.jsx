// Admin → Data protection: rules for what may not leave the company by email (server: dlp.js).
import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, del } from '../../api.js';
import { Modal, Empty, useToast, ConfirmModal } from '../../components/ui.jsx';

const DETECTORS = [['card', 'Credit card numbers'], ['iban', 'Bank account numbers (IBAN)'], ['words', 'Words or phrases'], ['pattern', 'A pattern of my own']];
const nameOf = (d) => DETECTORS.find(([k]) => k === d)?.[1] || d;
const EMPTY = { name: '', detector: 'card', words: '', pattern: '', action: 'warn', scope: 'outside', enabled: true };

export default function DataProtectionAdmin() {
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const load = useCallback(() => get('/dlp/rules').then(setRules).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!rules) return null;
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="card stack">
        <div className="row"><h2 className="grow" style={{ margin: 0 }}>Data protection</h2><button type="button" className="btn primary" onClick={() => setEditing(EMPTY)}>Add rule</button></div>
        <p className="muted small" style={{ margin: 0 }}>Rules look through email sent from Workspace (the subject and the message, mail merges too) before it goes. A rule that <strong>blocks</strong> stops the message and tells the sender why; one that <strong>warns</strong> asks the sender to confirm. Both are recorded in Activity. Card numbers and IBANs must have valid check digits, so order numbers and phone numbers don’t count. Mail sent from phone and computer mail apps isn’t checked.</p>
        {rules.length ? (
          <table className="table" aria-label="Data protection rules">
            <thead><tr><th>Rule</th><th>Looks for</th><th>When sent to</th><th>Then</th><th>On</th><th /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="small">{nameOf(r.detector)}{r.detector === 'words' && <span className="muted">: {r.words.join(', ')}</span>}{r.detector === 'pattern' && <code className="small"> {r.pattern}</code>}</td>
                  <td className="small">{r.scope === 'all' ? 'Anyone' : 'People outside the company'}</td>
                  <td><span className={`pill ${r.action === 'block' ? 'danger' : 'warn'}`}>{r.action === 'block' ? 'Block' : 'Warn'}</span></td>
                  <td><input type="checkbox" checked={r.enabled} aria-label={`${r.name} on`} onChange={async (e) => { try { await patch(`/dlp/rules/${r.id}`, { enabled: e.target.checked }); load(); } catch (err) { toast(err.message, 'error'); } }} /></td>
                  <td className="row end" style={{ gap: 4 }}>
                    <button type="button" className="btn small" onClick={() => setEditing({ ...r, words: r.words.join(', ') })}>Edit</button>
                    <button type="button" className="btn small danger" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title="No rules yet">Add one to stop card numbers, bank details or confidential project names from being emailed out by mistake.</Empty>}
      </div>
      {editing && <RuleForm rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && <ConfirmModal title={`Delete “${deleting.name}”?`} message="Email will no longer be checked for it." onClose={() => setDeleting(null)}
        onConfirm={async () => { await del(`/dlp/rules/${deleting.id}`); toast('Rule deleted'); setDeleting(null); load(); }} />}
    </div>
  );
}

function RuleForm({ rule, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(rule);
  const [sample, setSample] = useState('');
  const [tried, setTried] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const body = () => ({ name: f.name, detector: f.detector, words: f.words, pattern: f.pattern, action: f.action, scope: f.scope, enabled: f.enabled });
  const save = async (e) => {
    e.preventDefault();
    try { if (rule.id) await patch(`/dlp/rules/${rule.id}`, body()); else await post('/dlp/rules', body()); toast(rule.id ? 'Rule saved' : 'Rule added'); onSaved(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const tryIt = async () => {
    try { setTried((await post('/dlp/test', { rule: { ...body(), name: f.name || 'Test' }, text: sample })).found); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal title={rule.id ? 'Edit rule' : 'New rule'} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input value={f.name} onChange={set('name')} maxLength={80} required autoFocus placeholder="Card numbers" /></label>
        <label className="field"><span>Look for</span><select value={f.detector} onChange={set('detector')}>{DETECTORS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {f.detector === 'words' && <label className="field"><span>Words or phrases (separated by commas)</span><textarea rows={2} value={f.words} onChange={set('words')} placeholder="Project Falcon, payroll" /></label>}
        {f.detector === 'pattern' && <label className="field"><span>Pattern (a regular expression)</span><input value={f.pattern} onChange={set('pattern')} maxLength={200} placeholder="\b\d{6}-\d{2}-\d{4}\b" spellCheck={false} /></label>}
        <div className="row wrap">
          <label className="field"><span>When sent to</span><select value={f.scope} onChange={set('scope')}><option value="outside">People outside the company</option><option value="all">Anyone</option></select></label>
          <label className="field"><span>Then</span><select value={f.action} onChange={set('action')}><option value="warn">Warn the sender (they can still send)</option><option value="block">Block the message</option></select></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> On</label>
        <fieldset className="stack"><legend>Try it</legend>
          <textarea rows={2} aria-label="Text to try the rule on" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Paste some text…" />
          <div className="row"><button type="button" className="btn small" onClick={tryIt}>Try</button>
            {tried && <span className="small" role="status">{tried.length ? `Found: ${tried.join(', ')}` : 'Nothing found'}</span>}</div>
        </fieldset>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{rule.id ? 'Save' : 'Add rule'}</button></div>
      </form>
    </Modal>
  );
}
