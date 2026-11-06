import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { get, post, patch, del, onLive, uploadFile, formatBytes } from '../../api.js';
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
  const [threadId, setThreadId] = useState(null); // the message whose thread is open beside the conversation
  const [dialog, setDialog] = useState(false);
  const scroller = useRef();
  const stick = useRef(true);

  const loadChannels = () => get('/chat/channels').then(({ channels, online }) => {
    setChannels(channels); setOnline(online);
    setUnread(Object.fromEntries(channels.map((c) => [c.id, c.id === channelIdRef.current ? 0 : c.unread || 0])));
  });
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // Reading a conversation marks it read (also for your other tabs and devices).
  const markRead = (id) => { if (id && !document.hidden) post(`/chat/channels/${id}/read`).catch(() => {}); };
  useEffect(() => {
    const back = () => markRead(channelIdRef.current);
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
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
    setEditingId(null); setFiles([]); setThreadId(null);
    get(`/chat/channels/${channelId}/messages`).then((list) => { setMessages(list); markRead(channelId); }).catch((e) => toast(e.message, 'error'));
  }, [channelId, toast]);

  useEffect(() => onLive((m) => {
    if (m.type === 'message' && m.message.parent_id) {
      // A reply: its thread shows it, and its message's count comes as an update. Unread counts for
      // threads you're in come from the server.
      if (m.message.channel_id !== channelId && m.message.user_id !== user.id) loadChannels();
      else if (m.message.user_id !== user.id) markRead(channelId);
    } else if (m.type === 'message') {
      if (m.message.channel_id === channelId) { setMessages((list) => (list.some((x) => x.id === m.message.id) ? list : [...list, m.message])); if (m.message.user_id !== user.id) markRead(channelId); }
      else if (m.message.user_id !== user.id) setUnread((u) => ({ ...u, [m.message.channel_id]: (u[m.message.channel_id] || 0) + 1 }));
    } else if (m.type === 'message-updated') {
      setMessages((list) => list.map((x) => (x.id === m.message.id ? m.message : x)));
    } else if (m.type === 'chat-read') {
      setUnread((u) => ({ ...u, [m.channel_id]: 0 }));
    } else if (m.type === 'message-deleted') {
      setMessages((list) => list.filter((x) => x.id !== m.id));
      setThreadId((t) => (t === m.id ? null : t));
    } else if (m.type === 'channels-changed' || m.type === 'live-connected') {
      loadChannels();
    }
  }), [channelId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Files to send with the next message: uploaded to your "Chat files" folder in Drive.
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  async function attach(list) {
    let folder;
    try { folder = (await post('/chat/files-folder')).id; } catch (e) { toast(e.message, 'error'); return; }
    for (const f of list) {
      setUploading((n) => n + 1);
      try { const up = await uploadFile(f, folder); setFiles((x) => [...x, up]); } catch (e) { toast(e.message, 'error'); } finally { setUploading((n) => n - 1); }
    }
    box.current?.focus();
  }

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if ((!body && !files.length) || uploading) return;
    const sending = files;
    setText(''); setFiles([]);
    stick.current = true;
    try {
      const msg = await post(`/chat/channels/${channelId}/messages`, { body, files: sending.map((f) => f.id) });
      setMessages((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg]));
    } catch (err) { toast(err.message, 'error'); setText(body); setFiles(sending); }
  }

  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  async function saveEdit(m) {
    const body = editText.trim();
    if (body === m.body) { setEditingId(null); return; }
    try { const msg = await patch(`/chat/messages/${m.id}`, { body }); setMessages((list) => list.map((x) => (x.id === msg.id ? msg : x))); setEditingId(null); }
    catch (err) { toast(err.message, 'error'); }
  }
  const react = (m, emoji) => post(`/chat/messages/${m.id}/reactions`, { emoji })
    .then((msg) => setMessages((list) => list.map((x) => (x.id === msg.id ? msg : x)))).catch((err) => toast(err.message, 'error'));

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
                  <Message m={m} grouped={grouped && !newDay} user={user} editing={editingId === m.id} editText={editText} setEditText={setEditText}
                    onStartEdit={() => { setEditingId(m.id); setEditText(m.body); }} onSaveEdit={() => saveEdit(m)} onCancelEdit={() => setEditingId(null)}
                    onReact={(e) => react(m, e)} onThread={() => setThreadId(m.id)} onDelete={() => del(`/chat/messages/${m.id}`).catch((e) => toast(e.message, 'error'))} />
                </div>
              );
            })}
          </div>
          {(files.length > 0 || uploading > 0) && (
            <ul className="pending-files" aria-label="Files to send">
              {files.map((f) => <li key={f.id}><Icon name="attach" size={14} /> {f.name} <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><Icon name="close" size={14} /></button></li>)}
              {uploading > 0 && <li className="muted">Uploading {uploading}…</li>}
            </ul>
          )}
          <form className="composer" onSubmit={send} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); attach([...e.dataTransfer.files]); } }}>
            <EmojiPicker up className="icon-btn" onPick={insertEmoji} />
            <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files (or drop or paste them here)" onClick={() => fileInput.current.click()}><Icon name="attach" /></button>
            <input ref={fileInput} type="file" multiple hidden aria-label="Files to attach" onChange={(e) => { attach([...e.target.files]); e.target.value = ''; }} />
            <textarea ref={box} rows={1} value={text} placeholder={`Message ${title}`} aria-label="Message" onChange={(e) => setText(e.target.value)}
              onPaste={(e) => { const pasted = [...(e.clipboardData?.files || [])]; if (pasted.length) { e.preventDefault(); attach(pasted); } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
            <button className="icon-btn send" aria-label="Send" disabled={(!text.trim() && !files.length) || uploading > 0}><Icon name="send" /></button>
          </form>
        </>}
      </section>
      {current && threadId && <Thread key={threadId} id={threadId} channelId={channelId} user={user} onClose={() => setThreadId(null)} />}
      {dialog === 'email' && <PromptModal title="Message someone at another company" label="Their email address" confirm="Start chat" onClose={() => setDialog(false)}
        onSubmit={async (email) => { const p = await get(`/users/lookup?email=${encodeURIComponent(email)}`); await openDm(p.id); }} />}
      {dialog === true && <PromptModal title="New channel" label="Channel name" confirm="Create" onClose={() => setDialog(false)}
        onSubmit={async (name) => { const c = await post('/chat/channels', { name }); await loadChannels(); navigate(`/chat/${c.id}`); }} />}
    </div>
  );
}

/** A thread beside the conversation: the message, its replies (live), and a box to reply. */
function Thread({ id, channelId, user, onClose }) {
  const toast = useToast();
  const [parent, setParent] = useState(null);
  const [replies, setReplies] = useState([]);
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const end = useRef();
  const box = useRef();
  useEffect(() => {
    get(`/chat/messages/${id}/replies`).then((t) => { setParent(t.message); setReplies(t.replies); }).catch((e) => { toast(e.message, 'error'); onClose(); });
    box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => onLive((m) => {
    if (m.type === 'message' && m.message.parent_id === id) setReplies((list) => (list.some((x) => x.id === m.message.id) ? list : [...list, m.message]));
    else if (m.type === 'message-updated') {
      if (m.message.id === id) setParent(m.message);
      else setReplies((list) => list.map((x) => (x.id === m.message.id ? m.message : x)));
    } else if (m.type === 'message-deleted' && m.parent_id === id) setReplies((list) => list.filter((x) => x.id !== m.id));
  }), [id]);
  useLayoutEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [replies.length]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const replace = (msg) => { if (msg.id === id) setParent(msg); else setReplies((list) => list.map((x) => (x.id === msg.id ? msg : x))); };
  const react = (m, emoji) => post(`/chat/messages/${m.id}/reactions`, { emoji }).then(replace).catch((err) => toast(err.message, 'error'));
  async function saveEdit(m) {
    const body = editText.trim();
    if (body === m.body) { setEditingId(null); return; }
    try { replace(await patch(`/chat/messages/${m.id}`, { body })); setEditingId(null); } catch (err) { toast(err.message, 'error'); }
  }
  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    try { const msg = await post(`/chat/channels/${channelId}/messages`, { body, parent_id: id }); setReplies((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg])); }
    catch (err) { toast(err.message, 'error'); setText(body); }
  }
  const item = (m, grouped) => (
    <Message key={m.id} m={m} grouped={grouped} user={user} editing={editingId === m.id} editText={editText} setEditText={setEditText}
      onStartEdit={() => { setEditingId(m.id); setEditText(m.body); }} onSaveEdit={() => saveEdit(m)} onCancelEdit={() => setEditingId(null)}
      onReact={(e) => react(m, e)} onDelete={() => del(`/chat/messages/${m.id}`).then(() => { if (m.id === id) onClose(); }).catch((err) => toast(err.message, 'error'))} />
  );
  return (
    <aside className="thread-panel" aria-label="Thread">
      <div className="row thread-head"><h2 className="grow">Thread</h2><button type="button" className="icon-btn" aria-label="Close thread" onClick={onClose}><Icon name="close" /></button></div>
      <div className="thread-body">
        {parent && item(parent, false)}
        {parent && <div className="thread-count muted small">{replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</div>}
        {replies.map((m, i) => item(m, i > 0 && replies[i - 1].user_id === m.user_id && m.created_at - replies[i - 1].created_at < 5 * 60e3))}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        <EmojiPicker up className="icon-btn" onPick={(ch) => setText((v) => v + ch)} />
        <textarea ref={box} rows={1} value={text} placeholder="Reply…" aria-label="Reply" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
        <button className="icon-btn send" aria-label="Send reply" disabled={!text.trim()}><Icon name="send" /></button>
      </form>
    </aside>
  );
}

/** One message: text (or the box to change it), files, reactions, its thread, and hover actions. */
function Message({ m, grouped, user, editing, editText, setEditText, onStartEdit, onSaveEdit, onCancelEdit, onReact, onThread, onDelete }) {
  return (
    <div className={`msg ${grouped ? 'grouped' : ''}`}>
      {grouped ? <span className="msg-gutter" /> : <Avatar name={m.user_name || 'Deleted user'} size={36} />}
      <div className="msg-body">
        {!grouped && <div className="msg-meta"><strong>{m.user_name || 'Deleted user'}</strong> <span className="muted small">{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>}
        {editing ? (
          <form className="msg-edit" onSubmit={(e) => { e.preventDefault(); onSaveEdit(); }}>
            <textarea autoFocus aria-label="Change the message" value={editText} rows={Math.min(6, editText.split('\n').length)} onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(); } else if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); } }} />
            <span className="muted small">Enter to save · Esc to cancel</span>
          </form>
        ) : m.body && <div className="msg-text"><Linked text={m.body} />{m.edited_at && <span className="muted small edited" title={`Edited ${new Date(m.edited_at).toLocaleString()}`}> (edited)</span>}</div>}
        {m.files?.length > 0 && (
          <div className="msg-files">
            {m.files.map((f) => (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)
              ? <a key={f.id} href={`/api/chat/messages/${m.id}/files/${f.id}`} target="_blank" rel="noreferrer" className="msg-pic"><img src={`/api/chat/messages/${m.id}/files/${f.id}`} alt={f.name} loading="lazy" /></a>
              : <a key={f.id} className="msg-file" href={`/api/chat/messages/${m.id}/files/${f.id}?download`}><Icon name="attach" size={16} /> {f.name} <span className="muted small">{formatBytes(f.size)}</span></a>))}
          </div>
        )}
        {m.reactions?.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => {
              const mine = r.users.some((u) => u.id === user.id);
              return <button key={r.emoji} type="button" className={`reaction ${mine ? 'mine' : ''}`} aria-pressed={mine} title={r.users.map((u) => u.name).join(', ')}
                aria-label={`${r.emoji} ${r.users.length}: ${r.users.map((u) => u.name).join(', ')}`} onClick={() => onReact(r.emoji)}>{r.emoji} {r.users.length}</button>;
            })}
          </div>
        )}
        {onThread && m.reply_count > 0 && (
          <button type="button" className="thread-summary" onClick={onThread}>
            <span className="thread-faces">{(m.repliers || []).map((n) => <Avatar key={n} name={n} size={20} />)}</span>
            <strong>{m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}</strong>
            <span className="muted small">Last reply {timeOrDay(m.last_reply_at)}</span>
          </button>
        )}
      </div>
      <div className="msg-actions">
        {['👍', '❤️', '😂'].map((e) => <button key={e} type="button" className="icon-btn" aria-label={`React with ${e}`} onClick={() => onReact(e)}>{e}</button>)}
        <EmojiPicker className="icon-btn" label="Add a reaction" onPick={(e) => onReact(e)} />
        {onThread && <button type="button" className="icon-btn" aria-label="Reply in thread" title="Reply in thread" onClick={onThread}><Icon name="reply" size={16} /></button>}
        {m.user_id === user.id && <button type="button" className="icon-btn" aria-label="Edit message" onClick={onStartEdit}><Icon name="edit" size={16} /></button>}
        {(m.user_id === user.id || user.is_admin) && (
          <button className="icon-btn" aria-label="Delete message" onClick={onDelete}><Icon name="trash" size={16} /></button>
        )}
      </div>
    </div>
  );
}

const timeOrDay = (ms) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
};

/** Message text with web addresses and links into the workspace (such as /docs/…) clickable. */
const LINK_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]|(?<![\w/])\/(?:docs|sheets|slides|drive|calendar|mail|chat)\/[\w-]+(?:\?[\w=&%-]+)?)/g;
export function Linked({ text }) {
  return String(text).split(LINK_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    return part.startsWith('/') ? <Link key={i} to={part}>{part}</Link> : <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
  });
}
