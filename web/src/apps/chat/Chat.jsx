import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { get, post, del, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import EmojiPicker from '../../components/EmojiPicker.jsx';
import { Avatar, Empty, PromptModal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

export default function Chat() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [channels, setChannels] = useState([]);
  const [online, setOnline] = useState([]);
  const [people, setPeople] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const box = useRef();
  // Put the emoji where the cursor was in the message box.
  const insertEmoji = (ch) => {
    const t = box.current;
    const from = t?.selectionStart ?? text.length, to = t?.selectionEnd ?? text.length;
    setText((v) => v.slice(0, from) + ch + v.slice(to));
    caret.current = from + ch.length;
  };
  // Back in the message box, just after the emoji, as soon as it's on screen.
  const caret = useRef(null);
  useLayoutEffect(() => {
    if (caret.current === null || !box.current) return;
    box.current.focus();
    box.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);
  const [unread, setUnread] = useState({});
  const [dialog, setDialog] = useState(false);
  const scroller = useRef();
  const stick = useRef(true);

  const loadChannels = () => get('/chat/channels').then(({ channels, online }) => { setChannels(channels); setOnline(online); });
  useEffect(() => { loadChannels(); get('/users/directory').then(setPeople); }, []);

  const current = channels.find((c) => c.id === channelId);
  useEffect(() => {
    if (!channelId && channels.length) navigate(`/chat/${channels[0].id}`, { replace: true });
  }, [channelId, channels, navigate]);

  useEffect(() => {
    if (!channelId) return;
    setMessages([]);
    stick.current = true;
    setUnread((u) => ({ ...u, [channelId]: 0 }));
    get(`/chat/channels/${channelId}/messages`).then(setMessages).catch((e) => toast(e.message, 'error'));
  }, [channelId, toast]);

  useEffect(() => onLive((m) => {
    if (m.type === 'message') {
      if (m.message.channel_id === channelId) setMessages((list) => (list.some((x) => x.id === m.message.id) ? list : [...list, m.message]));
      else setUnread((u) => ({ ...u, [m.message.channel_id]: (u[m.message.channel_id] || 0) + 1 }));
    } else if (m.type === 'message-deleted') {
      setMessages((list) => list.filter((x) => x.id !== m.id));
    } else if (m.type === 'channels-changed' || m.type === 'live-connected') {
      loadChannels();
    }
  }), [channelId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    stick.current = true;
    try {
      const msg = await post(`/chat/channels/${channelId}/messages`, { body });
      setMessages((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg]));
    } catch (err) { toast(err.message, 'error'); setText(body); }
  }

  async function openDm(personId) {
    const { id } = await post('/chat/dm', { user_id: personId });
    await loadChannels();
    navigate(`/chat/${id}`);
  }

  const publicChannels = channels.filter((c) => !c.dm_key);
  const dms = channels.filter((c) => c.dm_key);
  const title = current ? (current.dm_key ? (current.dm_name || 'Notes to self') + (current.dm_org ? ` (${current.dm_org})` : '') : `# ${current.name}`) : '';

  return (
    <div className="chat">
      <aside className="subnav">
        <div className="subnav-title row">Channels<div className="grow" /><button className="icon-btn" aria-label="New channel" onClick={() => setDialog(true)}><Icon name="plus" size={18} /></button></div>
        {publicChannels.map((c) => (
          <button key={c.id} className={`subnav-item ${c.id === channelId ? 'active' : ''}`} onClick={() => navigate(`/chat/${c.id}`)}>
            <span className="hash">#</span><span className="grow ellipsis">{c.name}</span>{unread[c.id] > 0 && <span className="badge">{unread[c.id]}</span>}
          </button>
        ))}
        <div className="subnav-title">Direct messages</div>
        {dms.map((c) => (
          <button key={c.id} className={`subnav-item ${c.id === channelId ? 'active' : ''}`} onClick={() => navigate(`/chat/${c.id}`)}>
            <Avatar name={c.dm_name || user.name} size={20} /><span className="grow ellipsis">{c.dm_name || 'Notes to self'}{c.dm_org && <span className="muted small"> · {c.dm_org}</span>}</span>{unread[c.id] > 0 && <span className="badge">{unread[c.id]}</span>}
          </button>
        ))}
        <select className="dm-pick" value="" aria-label="Start a direct message" onChange={(e) => {
          if (e.target.value === '__email__') setDialog('email'); else if (e.target.value) openDm(e.target.value);
        }}>
          <option value="">+ Message someone…</option>
          {people.filter((p) => p.id !== user.id).map((p) => <option key={p.id} value={p.id}>{p.name}{online.includes(p.id) ? ' ●' : ''}</option>)}
          {user.allow_external && <option value="__email__">Someone at another company…</option>}
        </select>
      </aside>
      <section className="chat-main">
        {!current ? <Empty icon="chat" title="Pick a conversation" /> : <>
          <div className="chat-head"><h1>{title}</h1></div>
          <div className="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {messages.length === 0 && <Empty icon="chat" title="No messages yet">Say hello 👋</Empty>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped = prev && prev.user_id === m.user_id && m.created_at - prev.created_at < 5 * 60e3;
              const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
              return (
                <div key={m.id}>
                  {newDay && <div className="day-sep"><span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}
                  <div className={`msg ${grouped && !newDay ? 'grouped' : ''}`}>
                    {grouped && !newDay ? <span className="msg-gutter" /> : <Avatar name={m.user_name || 'Deleted user'} size={36} />}
                    <div className="msg-body">
                      {(!grouped || newDay) && <div className="msg-meta"><strong>{m.user_name || 'Deleted user'}</strong> <span className="muted small">{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>}
                      <div className="msg-text"><Linked text={m.body} /></div>
                    </div>
                    {(m.user_id === user.id || user.is_admin) && (
                      <button className="icon-btn msg-del" aria-label="Delete message" onClick={() => del(`/chat/messages/${m.id}`).catch((e) => toast(e.message, 'error'))}><Icon name="trash" size={16} /></button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <form className="composer" onSubmit={send}>
            <EmojiPicker up className="icon-btn" onPick={insertEmoji} />
            <textarea ref={box} rows={1} value={text} placeholder={`Message ${title}`} aria-label="Message" onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
            <button className="icon-btn send" aria-label="Send" disabled={!text.trim()}><Icon name="send" /></button>
          </form>
        </>}
      </section>
      {dialog === 'email' && <PromptModal title="Message someone at another company" label="Their email address" confirm="Start chat" onClose={() => setDialog(false)}
        onSubmit={async (email) => { const p = await get(`/users/lookup?email=${encodeURIComponent(email)}`); await openDm(p.id); }} />}
      {dialog === true && <PromptModal title="New channel" label="Channel name" confirm="Create" onClose={() => setDialog(false)}
        onSubmit={async (name) => { const c = await post('/chat/channels', { name }); await loadChannels(); navigate(`/chat/${c.id}`); }} />}
    </div>
  );
}

/** Message text with web addresses and links into the workspace (such as /docs/…) clickable. */
const LINK_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]|(?<![\w/])\/(?:docs|sheets|slides|drive|calendar|mail|chat)\/[\w-]+(?:\?[\w=&%-]+)?)/g;
export function Linked({ text }) {
  return String(text).split(LINK_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    return part.startsWith('/') ? <Link key={i} to={part}>{part}</Link> : <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
  });
}
