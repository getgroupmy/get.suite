// Time off (Calendar → 🏖 Time off): ask for days off, see what you asked for and what was decided,
// and (if people report to you, or you're an admin and they report to nobody) approve or decline theirs.
// Approved time off shows on the calendar as an all-day out-of-office event.
import { useEffect, useState } from 'react';
import { get, post, put, del } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { localToday } from '../tasks/taskmath.js';
import { balanceText, daysText, HALVES } from './timeoffmath.js';

const KINDS = [['vacation', 'Vacation'], ['sick', 'Sick leave'], ['personal', 'Personal'], ['other', 'Other']];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const span = (r) => (r.start_date === r.end_date ? `${day(r.start_date)}${r.half ? ` (${HALVES[r.half]})` : ''}` : `${day(r.start_date)} – ${day(r.end_date)}`);
const STATUS = { pending: 'Waiting for an answer', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };

/** How many requests wait for this person's answer (for the sidebar's badge). */
export const waitingFor = (data) => (data?.to_decide || []).filter((r) => r.status === 'pending').length;

export default function TimeOff({ onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [f, setF] = useState(() => ({ start_date: localToday(), end_date: localToday(), kind: 'vacation', note: '', half: '' }));
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('mine'); // mine | team
  const [team, setTeam] = useState(null); // null: not loaded; false: nobody to show
  const loadTeam = () => get(`/time-off/team`).then(setTeam).catch(() => setTeam(false));
  useEffect(() => { loadTeam(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => { loadTeam(); return get('/time-off').then(setData).catch((e) => toast(e.message, 'error')); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg) => { toast(msg); load(); onChanged?.(); };
  const ask = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post('/time-off', { ...f, half: f.start_date === f.end_date ? f.half || null : null, tz: TZ });
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
      {team && team.people.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Whose time off" style={{ marginBottom: 12 }}>
          {[['mine', 'Yours'], ['team', 'Team']].map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
      )}
      {tab === 'team' && team ? <Team team={team} onChanged={loadTeam} /> : (
      <div className="stack">
        {waiting.length > 0 && (
          <section className="stack-tight" aria-label="Waiting for your answer">
            <strong>Waiting for your answer</strong>
            <ul className="timeoff-list">
              {waiting.map((r) => (
                <li key={r.id} className="stack-tight">
                  <div><strong>{r.name}</strong> · {r.kind_label}: {span(r)} <span className="muted small">({daysText(r.days)})</span></div>
                  {r.note && <div className="muted small">“{r.note}”</div>}
                  {r.kind === 'vacation' && balanceText(r.balance) && <div className="muted small">{r.name.split(' ')[0]} has {balanceText(r.balance)}</div>}
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
            {f.start_date === f.end_date && <label className="field"><span>Part of the day</span><select value={f.half} onChange={set('half')}>
              <option value="">All day</option><option value="am">Morning</option><option value="pm">Afternoon</option></select></label>}
            <label className="field"><span>Kind</span><select value={f.kind} onChange={set('kind')}>{KINDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
          </div>
          <label className="field"><span>Note (optional)</span><input value={f.note} maxLength={500} onChange={set('note')} placeholder="Family visit" /></label>
          {balanceText(data?.balance) && <p className="small" role="status" style={{ margin: 0 }}>You have {balanceText(data.balance)}.</p>}
          <p className="muted small" style={{ margin: 0 }}>{data?.approvers ? 'Whoever you report to (or an admin) is asked; once approved it’s on your calendar as out of office.' : 'Nobody needs to approve it: it goes straight on your calendar as out of office.'}</p>
          <div className="row end"><button type="submit" className="btn primary" disabled={busy}>Ask</button></div>
        </form>
        <section className="stack-tight" aria-label="Your time off">
          <strong>Your time off</strong>
          {!data ? <p className="muted">Loading…</p> : !data.mine.length ? <p className="muted small" style={{ margin: 0 }}>Nothing asked for yet.</p> : (
            <ul className="timeoff-list">
              {data.mine.map((r) => (
                <li key={r.id} className="row wrap" style={{ gap: 8 }}>
                  <span className="grow">{r.kind_label}: {span(r)} <span className="muted small">({daysText(r.days)})</span>
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
      )}
    </Modal>
  );
}

/** The team: each person's vacation this year and their time off in the next three months; admins set allowances. */
function Team({ team, onChanged }) {
  const toast = useToast();
  const [company, setCompany] = useState(team.company_days ?? '');
  const setDays = async (url, days, msg) => { try { await put(url, { days: days === '' ? null : Number(days) }); toast(msg); onChanged(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      {team.can_set && (
        <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); setDays('/time-off/allowance', company, company === '' ? 'No vacation limit' : `${company} vacation days a year for everyone`); }}>
          <label className="field"><span>Vacation days a year (company)</span><input type="number" min="0" max="366" value={company} placeholder="No limit" onChange={(e) => setCompany(e.target.value)} style={{ width: 140 }} /></label>
          <button type="submit" className="btn">Save</button>
          <span className="muted small grow">Leave it empty for no limit. Anyone can have their own number below.</span>
        </form>
      )}
      {team.can_set && <Holidays year={team.year} />}
      {team.can_set && (
        <p className="small" style={{ margin: 0 }}>
          <a href={`/api/time-off/report.csv?year=${team.year}`} download>Download {team.year}'s time off (.csv)</a>
          <span className="muted"> · approved time off with the working days each took, for payroll · </span>
          <a href={`/api/time-off/report.csv?year=${team.year}&all=1`} download>with every request</a>
        </p>
      )}
      <table className="timeoff-team">
        <thead><tr><th scope="col">Person</th><th scope="col">Vacation in {team.year}</th><th scope="col">Coming up</th>{team.can_set && <th scope="col">Days a year</th>}</tr></thead>
        <tbody>
          {team.people.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.name}</th>
              <td>{p.balance.days === null ? <span className="muted">{p.balance.used} taken</span> : <>{Math.max(0, p.balance.left)} left <span className="muted small">of {p.balance.days} · {p.balance.used} taken{p.balance.pending ? ` · ${p.balance.pending} asked` : ''}</span></>}</td>
              <td>{p.coming.length ? p.coming.map((c) => <div key={c.id} className="small">{c.kind_label}: {span(c)}{c.status === 'pending' ? ' (asked)' : ''}</div>) : <span className="muted small">—</span>}</td>
              {team.can_set && <td><OwnDays p={p} onSave={(v) => setDays(`/time-off/allowance/${p.id}`, v, v === '' ? `${p.name}: the company's number` : `${p.name}: ${v} days a year`)} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** Company holidays (admins): days off for everyone, on everyone's calendar, not counted in time off. */
function Holidays({ year }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [f, setF] = useState({ date: '', name: '' });
  const load = () => get(`/time-off/holidays?from=${year}-01-01&to=${year + 1}-12-31`).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (e) => {
    e.preventDefault();
    try { await post('/time-off/holidays', f); toast(`${f.name} added`); setF({ date: '', name: '' }); load(); } catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (h) => { try { await del(`/time-off/holidays/${h.id}`); toast(`${h.name} removed`); load(); } catch (err) { toast(err.message, 'error'); } };
  return (
    <section className="stack-tight" aria-label="Company holidays">
      <strong>Company holidays</strong>
      <p className="muted small" style={{ margin: 0 }}>Days off for everyone: on everyone's calendar, and not counted as working days in time off.</p>
      {list?.length ? (
        <ul className="timeoff-list">
          {list.map((h) => <li key={h.id} className="row" style={{ gap: 8 }}><span className="grow">{day(h.date)} · {h.name}</span><button type="button" className="btn small" aria-label={`Remove ${h.name}`} onClick={() => remove(h)}>Remove</button></li>)}
        </ul>
      ) : list && <p className="muted small" style={{ margin: 0 }}>None yet.</p>}
      <form className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={add}>
        <label className="field"><span>Holiday</span><input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="field grow"><span>Name</span><input required maxLength={100} value={f.name} placeholder="New Year's Day" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <button type="submit" className="btn">Add holiday</button>
      </form>
    </section>
  );
}
function OwnDays({ p, onSave }) {
  const [v, setV] = useState(p.own_days ?? '');
  return <input type="number" min="0" max="366" aria-label={`Vacation days a year for ${p.name}`} placeholder="Company's" value={v} style={{ width: 110 }}
    onChange={(e) => setV(e.target.value)} onBlur={() => { if (String(v) !== String(p.own_days ?? '')) onSave(v); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}
