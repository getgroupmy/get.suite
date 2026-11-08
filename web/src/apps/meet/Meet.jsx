// Meet: /meet starts a meeting or joins one by its code; /meet/:code is the meeting itself (MeetRoom).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { useToast, Modal } from '../../components/ui.jsx';
import { parseCode } from './meetmath.js';

export default function Meet() {
  const navigate = useNavigate();
  const toast = useToast();
  const [recent, setRecent] = useState(null);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [attendance, setAttendance] = useState(null); // the meeting whose "Who joined" is open
  useEffect(() => { get('/meet').then(setRecent).catch(() => setRecent([])); }, []);
  const start = async (e) => {
    e?.preventDefault();
    try { const m = await post('/meet', { title }); navigate(`/meet/${m.code}`); } catch (err) { toast(err.message, 'error'); }
  };
  const join = (e) => {
    e.preventDefault();
    const c = parseCode(code);
    if (!c) return toast('That doesn’t look like a meeting code (like abc-defg-hij)', 'error');
    navigate(`/meet/${c}`);
  };
  return (
    <div className="page meet-home">
      <div className="page-head"><h1>Meet</h1></div>
      <p className="muted" style={{ margin: 0 }}>Video meetings with colleagues, right in the browser. Share the link or the code to bring people in.</p>
      <div className="meet-start">
        <form className="card stack" onSubmit={start} aria-label="Start a meeting">
          <strong>Start a meeting</strong>
          <input aria-label="Meeting name (optional)" placeholder="Name (optional), e.g. Weekly standup" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <div><button className="btn primary"><Icon name="video" size={18} /> New meeting</button></div>
        </form>
        <form className="card stack" onSubmit={join} aria-label="Join a meeting">
          <strong>Join with a code</strong>
          <input aria-label="Meeting code or link" placeholder="abc-defg-hij" value={code} onChange={(e) => setCode(e.target.value)} />
          <div><button className="btn" disabled={!code.trim()}>Join</button></div>
        </form>
      </div>
      {recent?.length > 0 && (
        <section className="stack-tight" aria-label="Recent meetings">
          <strong>Recent meetings</strong>
          <ul className="form-list">
            {recent.map((m) => (
              <li key={m.code} className="row meet-recent">
                <button type="button" className="form-row grow" onClick={() => navigate(`/meet/${m.code}`)}>
                  <Icon name="video" />
                  <span className="grow"><span className="form-row-title">{m.title || m.code}</span>
                    <span className="muted small">{m.title ? `${m.code} · ` : ''}started by {m.created_by_name || 'someone'} · last used {formatDate(m.last_used)}</span></span>
                  {m.people > 0 && <span className="tag live">{m.people} in the meeting</span>}
                </button>
                <button type="button" className="btn small" aria-label={`Who joined ${m.title || m.code}`} onClick={() => setAttendance(m)}>Who joined</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {attendance && <Attendance meeting={attendance} onClose={() => setAttendance(null)} />}
    </div>
  );
}

/** Who came to a meeting: first joined, last left, time there and how many times. */
function Attendance({ meeting, onClose }) {
  const toast = useToast();
  const [a, setA] = useState(null);
  useEffect(() => { get(`/meet/${meeting.code}/attendance`).then(setA).catch((e) => { toast(e.message, 'error'); onClose(); }); }, [meeting.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const time = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  return (
    <Modal title={`Who joined ${meeting.title || meeting.code}`} onClose={onClose} wide footer={<>
      <a className="btn" href={`/api/meet/${meeting.code}/attendance?format=csv`} download><Icon name="download" size={16} /> Download CSV</a>
      <button type="button" className="btn primary" onClick={onClose}>Done</button>
    </>}>
      {!a ? <p className="muted">Loading…</p> : !a.people.length ? <p className="muted">Nobody has joined yet.</p> : (
        <table className="files attendance" aria-label="Attendance">
          <thead><tr><th>Name</th><th>First joined</th><th>Last left</th><th>Time there</th></tr></thead>
          <tbody>
            {a.people.map((p) => (
              <tr key={`${p.email}-${p.first}`}>
                <td>{p.name}<div className="muted small">{p.email}</div></td>
                <td className="muted">{time(p.first)}</td>
                <td className="muted">{p.here ? <span className="tag live">still there</span> : time(p.last)}</td>
                <td>{p.minutes < 1 ? 'under a minute' : `${p.minutes} min`}{p.times > 1 ? <span className="muted small"> · joined {p.times} times</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
