// Approvals: ask colleagues to approve a file, see what's waiting for you, and approve or reject.
// RequestApproval is the window from a file's menu; ApprovalsView is Drive → Approvals; ApprovalBanner
// sits at the top of a document, spreadsheet or presentation.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive, refreshOn, formatDate } from '../../api.js';
import Icon, { fileIcon } from '../../components/Icon.jsx';
import { Avatar, Empty, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

const OPEN = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}` };
export const STATUS_TEXT = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected' };

/** Ask colleagues (who can open the file) to approve it. */
export function RequestApproval({ file, onClose, onDone }) {
  const toast = useToast();
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState(new Set());
  const [message, setMessage] = useState('');
  const [due, setDue] = useState('');
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== user.id))).catch(() => {}); }, [user.id]);
  const send = async () => {
    try { await post('/approvals', { file_id: file.id, reviewers: [...chosen], message, due: due || null }); toast(`Asked ${chosen.size === 1 ? '1 person' : `${chosen.size} people`} to approve “${file.name}”`); onDone?.(); onClose(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Request approval: ${file.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!chosen.size} onClick={send}>Send request</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Each reviewer approves or rejects it. It's approved when everyone has approved, and rejected if anyone rejects it. They need to be able to open the file (share it with them first).</p>
        <fieldset className="stack-tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small"><strong>Reviewers</strong></legend>
          <ul className="group-people" aria-label="Reviewers">
            {people.map((p) => <li key={p.id}><label className="check"><input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(p.id) : n.delete(p.id); setChosen(n); }} /> <Avatar name={p.name} size={22} userId={p.id} /> {p.name}</label></li>)}
          </ul>
        </fieldset>
        <label className="field"><span>Message (optional)</span><textarea rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What should they look at?" /></label>
        <label className="field" style={{ maxWidth: 220 }}><span>Needed by (optional)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

/** Approve or reject, with an optional comment. */
function Decide({ approval, onDone }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const decide = async (decision) => {
    try { await post(`/approvals/${approval.id}/decide`, { decision, comment }); toast(decision === 'approved' ? 'Approved' : 'Rejected'); onDone?.(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="row wrap approval-decide">
      <input className="grow" aria-label="Comment (optional)" placeholder="Comment (optional)" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
      <button type="button" className="btn primary" onClick={() => decide('approved')}>✓ Approve</button>
      <button type="button" className="btn" onClick={() => decide('rejected')}>✕ Reject</button>
    </div>
  );
}

function Reviewers({ approval }) {
  return (
    <ul className="approval-reviewers">
      {approval.reviewers.map((r) => (
        <li key={r.id} className="row">
          <Avatar name={r.name} size={20} userId={r.id} />
          <span className="grow">{r.name}{r.comment && <span className="muted small"> · “{r.comment}”</span>}</span>
          <span className={`pill approval-${r.decision || 'waiting'}`}>{r.decision === 'approved' ? 'Approved' : r.decision === 'rejected' ? 'Rejected' : 'Waiting'}</span>
        </li>
      ))}
    </ul>
  );
}

/** At the top of a file: what it's waiting for, or how it was decided. */
export function ApprovalBanner({ fileId }) {
  const { user } = useAuth();
  const [a, setA] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => get(`/approvals/file/${fileId}`).then((r) => setA(r.current)).catch(() => {}), [fileId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'live-connected' || (m.type === 'approvals-changed' && m.file_id === fileId)) load(); }), [fileId, load]);
  if (!a) return null;
  const me = a.reviewers.find((r) => r.id === user.id);
  const myTurn = a.status === 'pending' && me && !me.decision;
  return (
    <div className={`banner approval-banner approval-${a.status}`} role="region" aria-label="Approval">
      <div className="row wrap">
        <strong>{a.status === 'approved' ? '✓ Approved' : a.status === 'rejected' ? '✕ Rejected' : myTurn ? `${a.requested_by?.name} asked you to approve this` : 'Waiting for approval'}</strong>
        <span className="muted small grow">
          {a.status === 'pending' ? `${a.reviewers.filter((r) => r.decision === 'approved').length} of ${a.reviewers.length} approved${a.due ? ` · needed by ${a.due}` : ''}` : `${formatDate(a.decided_at)}`}
          {a.changed_since && ' · changed since it was approved'}
        </span>
        <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
        {a.status === 'pending' && a.requested_by?.id === user.id && <button type="button" className="link-btn small" onClick={async () => { await post(`/approvals/${a.id}/cancel`); load(); }}>Cancel request</button>}
      </div>
      {a.message && (open || myTurn) && <p className="small" style={{ margin: '4px 0 0' }}>“{a.message}”</p>}
      {open && <Reviewers approval={a} />}
      {myTurn && <Decide approval={a} onDone={load} />}
    </div>
  );
}

/** Drive → Approvals: waiting for you, and what you asked for. */
export function ApprovalsView() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const load = useCallback(() => get('/approvals').then(setData).catch(() => setData({ waiting: [], requested: [] })), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (refreshOn(m, 'approvals-changed')) load(); }), [load]);
  if (!data) return null;
  const row = (a, mine) => (
    <li key={a.id} className="card approval-row" aria-label={`Approval: ${a.file.name}`}>
      <div className="row">
        <Icon name={fileIcon(a.file)} />
        <button type="button" className="link-btn grow approval-file" onClick={() => navigate(OPEN[a.file.kind]?.(a.file) || '/drive/recent')}>{a.file.name}</button>
        <span className={`pill approval-${a.status}`}>{STATUS_TEXT[a.status]}</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{mine ? 'You asked' : `${a.requested_by?.name} asked`} {formatDate(a.created_at)}{a.due ? ` · needed by ${a.due}` : ''}{a.message ? ` · “${a.message}”` : ''}{a.changed_since ? ' · changed since it was approved' : ''}</p>
      <Reviewers approval={a} />
      {!mine && <Decide approval={a} onDone={load} />}
    </li>
  );
  return (
    <div className="stack approvals-view">
      <h2 className="small muted">Waiting for you</h2>
      {data.waiting.length ? <ul className="approval-list">{data.waiting.map((a) => row(a, false))}</ul> : <p className="muted small">Nothing to approve.</p>}
      <h2 className="small muted">You asked</h2>
      {data.requested.length ? <ul className="approval-list">{data.requested.map((a) => row(a, true))}</ul> : <Empty icon="check" title="No approval requests">Use “Request approval…” in a file's menu.</Empty>}
    </div>
  );
}
