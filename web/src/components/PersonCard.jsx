// A colleague's card: who they are, their place in the org chart, how to reach them, whether it's
// working time for them now and where they're working today. Opened from the Directory and the org chart.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, del, onLive, formatDate } from '../api.js';
import { Avatar, Modal, useToast } from './ui.jsx';
import { useAuth } from '../App.jsx';
import WithPerson from './WithPerson.jsx';
import Clap from './Clap.jsx';
import Icon from './Icon.jsx';
import { statusLine, unreachableText } from './status.js';
import { placeText } from './workloc.js';
import { scheduleWith } from './scheduleWith.js';

const localTime = (tz) => new Date().toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit' });

const KUDOS_EMOJI = ['🙌', '🎉', '💪', '🌟', '🙏', '🚀', '❤️', '🏆'];

/** Thanks they've had (the latest few), and "Say thanks" for colleagues. */
function Thanks({ person, me }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // { emoji, message, channel_id } while writing
  const [channels, setChannels] = useState([]); // channels to post it in too (not direct messages or archived ones)
  useEffect(() => {
    if (!form || channels.length) return;
    get('/chat/channels').then((r) => setChannels((r.channels || []).filter((c) => !c.dm_key && !c.archived_at && c.member !== false))).catch(() => {});
  }, [form, channels.length]);
  const load = useCallback(() => get(`/kudos/for/${person.id}`).then(setData).catch(() => {}), [person.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'kudos-changed') load(); }), [load]);
  const send = async (e) => {
    e.preventDefault();
    try {
      await post('/kudos', { to: person.id, emoji: form.emoji, message: form.message, ...(form.channel_id && { channel_id: form.channel_id }) });
      const ch = channels.find((c) => c.id === form.channel_id);
      setForm(null); toast(`${form.emoji} Thanks sent to ${person.name}${ch ? `, and posted in #${ch.name}` : ''}`); load();
    } catch (err) { toast(err.message, 'error'); }
  };
  const takeBack = async (k) => { try { await del(`/kudos/${k.id}`); toast(k.mine ? 'Thanks taken back' : 'Thank-you removed'); load(); } catch (err) { toast(err.message, 'error'); } };
  return (
    <section className="stack-tight person-thanks" aria-label="Thanks">
      {person.id !== me && !form && <div><button type="button" className="btn" onClick={() => setForm({ emoji: KUDOS_EMOJI[0], message: '', channel_id: '' })}>🙌 Say thanks</button></div>}
      {form && (
        <form className="stack-tight" aria-label={`Thank ${person.name}`} onSubmit={send}>
          <div className="row wrap" role="radiogroup" aria-label="Emoji" style={{ gap: 4 }}>
            {KUDOS_EMOJI.map((em) => <button key={em} type="button" role="radio" aria-checked={form.emoji === em} aria-label={em} className={`icon-btn kudos-pick ${form.emoji === em ? 'on' : ''}`} onClick={() => setForm({ ...form, emoji: em })}>{em}</button>)}
          </div>
          <textarea aria-label="What for" placeholder={`What are you thanking ${person.name.split(' ')[0]} for?`} rows={2} maxLength={280} required autoFocus value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          {channels.length > 0 && (
            <label className="row small" style={{ gap: 6 }}>Also post in
              <select value={form.channel_id} onChange={(e) => setForm({ ...form, channel_id: e.target.value })}>
                <option value="">No channel</option>
                {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </label>
          )}
          <div className="row" style={{ gap: 6 }}><button className="btn primary small">Send thanks</button><button type="button" className="btn small" onClick={() => setForm(null)}>Cancel</button><span className="muted small">Everyone in the company can see it on Home.</span></div>
        </form>
      )}
      {data?.count > 0 && (
        <>
          <strong className="small">Thanks received ({data.count})</strong>
          <ul className="plain-list kudos-list" aria-label="Thanks received">
            {data.latest.slice(0, 5).map((k) => (
              <li key={k.id} className="row" style={{ gap: 6 }}>
                <span className="grow"><span aria-hidden="true">{k.emoji}</span> {k.message} <span className="muted small">— {k.from_name}, {formatDate(k.created_at)}</span> <Clap kudos={k} /></span>
                {k.can_remove && <button type="button" className="icon-btn" aria-label={k.mine ? 'Take back your thanks' : `Remove ${k.from_name}’s thanks (admin)`} title={k.mine ? 'Take back' : 'Remove (admins): kept in the activity log, and its giver is told'} onClick={() => takeBack(k)}><Icon name="close" size={14} /></button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

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
        <Thanks person={card} me={user.id} />
        {card.id !== user.id && <WithPerson email={card.email} onOpen={onClose} />}
      </div>
    </Modal>
  );
}
