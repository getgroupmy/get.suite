// Meet: /meet starts a meeting or joins one by its code; /meet/:code is the meeting itself (MeetRoom).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { useToast } from '../../components/ui.jsx';
import { parseCode } from './meetmath.js';
import { Attendance, KeptChat } from '../../components/MeetHistory.jsx';

export default function Meet() {
  const navigate = useNavigate();
  const toast = useToast();
  const [recent, setRecent] = useState(null);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [attendance, setAttendance] = useState(null); // the meeting whose "Who joined" is open
  const [chatOf, setChatOf] = useState(null); // the meeting whose kept chat is open
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
                {m.chat_count > 0 && <button type="button" className="btn small" aria-label={`Chat from ${m.title || m.code}`} onClick={() => setChatOf(m)}>💬 Chat</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {attendance && <Attendance meeting={attendance} onClose={() => setAttendance(null)} />}
      {chatOf && <KeptChat meeting={chatOf} onClose={() => setChatOf(null)} onDeleted={(kept) => setRecent((list) => list.map((x) => (x.code === chatOf.code ? { ...x, chat_count: kept } : x)))} />}
    </div>
  );
}

