// After a meeting: who joined it, and its kept chat (Meet → Recent meetings, and a Calendar event's video meeting).
import { useEffect, useState } from 'react';
import { get, del } from '../api.js';
import Icon from './Icon.jsx';
import { useToast, Modal, ConfirmModal } from './ui.jsx';

/** A meeting's kept chat (its host turned on Keep the meeting chat), oldest first, with a download. */
export function KeptChat({ meeting, onClose, onDeleted }) {
  const toast = useToast();
  const [c, setC] = useState(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => { get(`/meet/${meeting.code}/chat`).then(setC).catch((e) => { toast(e.message, 'error'); onClose(); }); }, [meeting.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const time = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Modal title={`Chat from ${meeting.title || c?.title || meeting.code}`} onClose={onClose} footer={<>
      {c?.can_delete && c.messages.length > 0 && <button type="button" className="btn danger" onClick={() => setAsking(true)}><Icon name="trash" size={16} /> Delete chat</button>}
      <a className="btn" href={`/api/meet/${meeting.code}/chat?format=txt`} download><Icon name="download" size={16} /> Download (.txt)</a>
      <button type="button" className="btn primary" onClick={onClose}>Done</button>
    </>}>
      {!c ? <p className="muted">Loading…</p> : !c.messages.length ? <p className="muted">Nothing was kept.</p> : (
        <ul className="meet-chat kept" aria-label="Kept chat">
          {c.messages.map((x, i) => <li key={i}><strong>{x.name}</strong> <span className="muted small">{time(x.at)}{x.room ? ` · room ${x.room}` : ''}</span><div>{x.text}</div></li>)}
        </ul>
      )}
      {asking && <ConfirmModal title="Delete the meeting chat?" message="Everyone who was in the meeting loses it too. This can’t be undone." onClose={() => setAsking(false)}
        onConfirm={async () => {
          const r = await del(`/meet/${meeting.code}/chat`);
          setAsking(false);
          onDeleted?.(r.kept);
          if (r.kept) { toast(`Deleted. ${r.kept} ${r.kept === 1 ? 'line is' : 'lines are'} kept: written by someone on legal hold`); setC(await get(`/meet/${meeting.code}/chat`)); }
          else { toast('Meeting chat deleted'); onClose(); }
        }} />}
    </Modal>
  );
}

/** Who came to a meeting: first joined, last left, time there and how many times. */
export function Attendance({ meeting, onClose }) {
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
