// A colleague's card: who they are, their place in the org chart, how to reach them, whether it's
// working time for them now and where they're working today. Opened from the Directory and the org chart.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post } from '../api.js';
import { Avatar, Modal, useToast } from './ui.jsx';
import { useAuth } from '../App.jsx';
import WithPerson from './WithPerson.jsx';
import Icon from './Icon.jsx';
import { statusLine, unreachableText } from './status.js';
import { placeText } from './workloc.js';
import { scheduleWith } from './scheduleWith.js';

const localTime = (tz) => new Date().toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit' });

export default function PersonCard({ userId, onClose }) {
  const [id, setId] = useState(userId);
  const [card, setCard] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  useEffect(() => { setCard(null); get(`/users/${id}/card`).then(setCard).catch((e) => { toast(e.status === 404 ? 'Cards are for colleagues in your company' : e.message, 'error'); onClose(); }); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!card) return null;
  // Call: a video call in your direct messages with them; they're rung, and the meeting opens for you.
  const callThem = async () => {
    try {
      const r = await post('/chat/call', { user_id: card.id });
      onClose(); window.open(`/meet/${r.code}`, '_blank', 'noopener'); navigate(`/chat/${r.channel_id}`);
      if (r.unreachable?.length) toast(unreachableText(r.unreachable), 'info', { duration: 10000 });
    } catch (e) { toast(e.message, 'error'); }
  };
  const message = async () => { const { id: dm } = await post('/chat/dm', { user_id: card.id }); onClose(); navigate(`/chat/${dm}`); };
  const schedule = () => { onClose(); scheduleWith([{ id: card.id, email: card.email, name: card.name }], { navigate, toast }); };
  const seeCalendar = () => {
    try {
      const list = JSON.parse(localStorage.getItem('nw.calOthers') || '[]');
      if (!list.some((o) => o.id === card.id)) localStorage.setItem('nw.calOthers', JSON.stringify([...list, { id: card.id, name: card.name, color: '#8430ce' }].slice(-10)));
    } catch { /* private window */ }
    onClose(); navigate('/calendar');
  };
  const person = (p) => <button type="button" className="link-btn" onClick={() => setId(p.id)}>{p.name}</button>;
  return (
    <Modal title={card.name} onClose={onClose}>
      <div className="person-card stack" aria-label={`About ${card.name}`}>
        <div className="row" style={{ gap: 16 }}>
          <Avatar name={card.name} size={64} userId={card.id} />
          <div className="grow">
            {(card.job_title || card.department) && <div>{[card.job_title, card.department].filter(Boolean).join(' · ')}</div>}
            {card.status && <div className="small">{statusLine(card.status)}</div>}
            {card.paused_until && <div className="muted small">Notifications paused</div>}
          </div>
        </div>
        <dl className="person-facts">
          <dt>Email</dt><dd><a href={`mailto:${card.email}`}>{card.email}</a></dd>
          {card.work_phone && <><dt>Phone</dt><dd><a href={`tel:${card.work_phone}`}>{card.work_phone}</a></dd></>}
          {card.hours && <><dt>Local time</dt><dd>{localTime(card.hours.tz)} ({card.hours.tz.replace(/_/g, ' ')}) · {card.hours.working_now ? 'working hours' : 'outside working hours'}<span className="muted small"> · {card.hours.text}</span></dd></>}
          {card.where_today && <><dt>Today</dt><dd>{placeText(card.where_today)}</dd></>}
          {card.manager && <><dt>Reports to</dt><dd>{person(card.manager)}{card.manager.job_title && <span className="muted small"> · {card.manager.job_title}</span>}</dd></>}
          {card.reports.length > 0 && <><dt>{card.reports.length === 1 ? 'Report' : `Reports (${card.reports.length})`}</dt><dd>{card.reports.map((p, i) => <span key={p.id}>{i > 0 && ', '}{person(p)}</span>)}</dd></>}
        </dl>
        {card.id !== user.id && (
          <div className="row wrap">
            <button type="button" className="btn primary" onClick={message}><Icon name="chat" size={16} /> Message</button>
            <button type="button" className="btn" onClick={callThem} title="A video call: they're rung, wherever they are in Workspace"><Icon name="video" size={16} /> Call</button>
            <button type="button" className="btn" onClick={() => { onClose(); navigate(`/mail?compose=${encodeURIComponent(card.email)}`); }}><Icon name="mail" size={16} /> Email</button>
            <button type="button" className="btn" onClick={schedule} title="A new event with them, at the first time you're both free"><Icon name="calendar" size={16} /> Schedule a meeting</button>
            <button type="button" className="btn" onClick={seeCalendar}><Icon name="calendar" size={16} /> See their calendar</button>
          </div>
        )}
        {card.id !== user.id && <WithPerson email={card.email} onOpen={onClose} />}
      </div>
    </Modal>
  );
}
