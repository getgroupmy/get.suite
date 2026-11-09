// Time off (Calendar → 🏖 Time off): ask for days off, see what you asked for and what was decided,
// and (if people report to you, or you're an admin and they report to nobody) approve or decline theirs.
// Approved time off shows on the calendar as an all-day out-of-office event.
import { useEffect, useState } from 'react';
import { get, post, del } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { localToday } from '../tasks/taskmath.js';

const KINDS = [['vacation', 'Vacation'], ['sick', 'Sick leave'], ['personal', 'Personal'], ['other', 'Other']];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const span = (r) => (r.start_date === r.end_date ? day(r.start_date) : `${day(r.start_date)} – ${day(r.end_date)}`);
const STATUS = { pending: 'Waiting for an answer', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };

/** How many requests wait for this person's answer (for the sidebar's badge). */
export const waitingFor = (data) => (data?.to_decide || []).filter((r) => r.status === 'pending').length;

export default function TimeOff({ onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [f, setF] = useState(() => ({ start_date: localToday(), end_date: localToday(), kind: 'vacation', note: '' }));
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const load = () => get('/time-off').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg) => { toast(msg); load(); onChanged?.(); };
  const ask = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post('/time-off', { ...f, tz: TZ });
      done(r.status === 'approved' ? 'Time off added to your calendar' : 'Asked for time off');
      setF({ ...f, note: '' });
    } catch (err) { toast(err.message, 'error'); }
    setBusy(false);
  };
  const decide = async (r, approve) => {
    try { await post(`/time-off/${r.id}/decide`, { approve, answer: answers[r.id] || '' }); done(`${approve ? 'Approved' : 'Declined'} ${r.name}'s time off`); } catch (err) { toast(err.message, 'error'); }
  };
  const cancel = async (r) => { try { await del(`/time-off/${r.id}`); done('Time off cancelled'); } catch (err) { toast(err.message, 'error'); } };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'start_date' && f.end_date < e.target.value && { end_date: e.target.value }) });
  const waiting = (data?.to_decide || []).filter((r) => r.status === 'pending');
  const decided = (data?.to_decide || []).filter((r) => r.status !== 'pending');
  return (
    <Modal wide title="Time off" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        {waiting.length > 0 && (
          <section className="stack-tight" aria-label="Waiting for your answer">
            <strong>Waiting for your answer</strong>
            <ul className="timeoff-list">
              {waiting.map((r) => (
                <li key={r.id} className="stack-tight">
                  <div><strong>{r.name}</strong> · {r.kind_label}: {span(r)} <span className="muted small">({r.days} working day{r.days === 1 ? '' : 's'})</span></div>
                  {r.note && <div className="muted small">“{r.note}”</div>}
                  <div className="row wrap" style={{ gap: 6 }}>
                    <input className="grow" aria-label={`Answer to ${r.name} (optional)`} placeholder="Answer (optional)" value={answers[r.id] || ''} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
                    <button type="button" className="btn primary small" aria-label={`Approve ${r.name}'s time off`} onClick={() => decide(r, true)}>Approve</button>
                    <button type="button" className="btn small" aria-label={`Decline ${r.name}'s time off`} onClick={() => decide(r, false)}>Decline</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <form className="stack-tight" onSubmit={ask} aria-label="Ask for time off">
          <strong>Ask for time off</strong>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="field"><span>First day</span><input type="date" required value={f.start_date} onChange={set('start_date')} /></label>
            <label className="field"><span>Last day</span><input type="date" required min={f.start_date} value={f.end_date} onChange={set('end_date')} /></label>
            <label className="field"><span>Kind</span><select value={f.kind} onChange={set('kind')}>{KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
          </div>
          <label className="field"><span>Note (optional)</span><input value={f.note} maxLength={500} onChange={set('note')} placeholder="Family visit" /></label>
          <p className="muted small" style={{ margin: 0 }}>{data?.approvers ? 'Whoever you report to (or an admin) is asked; once approved it’s on your calendar as out of office.' : 'Nobody needs to approve it: it goes straight on your calendar as out of office.'}</p>
          <div className="row end"><button type="submit" className="btn primary" disabled={busy}>Ask</button></div>
        </form>
        <section className="stack-tight" aria-label="Your time off">
          <strong>Your time off</strong>
          {!data ? <p className="muted">Loading…</p> : !data.mine.length ? <p className="muted small" style={{ margin: 0 }}>Nothing asked for yet.</p> : (
            <ul className="timeoff-list">
              {data.mine.map((r) => (
                <li key={r.id} className="row wrap" style={{ gap: 8 }}>
                  <span className="grow">{r.kind_label}: {span(r)} <span className="muted small">({r.days} working day{r.days === 1 ? '' : 's'})</span>
                    <br /><span className={`small timeoff-${r.status}`}>{STATUS[r.status]}{r.decided_by_name && r.status !== 'cancelled' ? ` by ${r.decided_by_name}` : ''}{r.answer ? `: “${r.answer}”` : ''}</span></span>
                  {['pending', 'approved'].includes(r.status) && r.end_date >= localToday() && <button type="button" className="btn small" aria-label={`Cancel time off ${span(r)}`} onClick={() => cancel(r)}>Cancel</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
        {decided.length > 0 && (
          <details>
            <summary className="small">Decided in the last month ({decided.length})</summary>
            <ul className="timeoff-list">{decided.map((r) => <li key={r.id} className="small">{r.name} · {r.kind_label}: {span(r)} · {STATUS[r.status]}</li>)}</ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
