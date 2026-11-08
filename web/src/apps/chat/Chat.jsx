import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { blocks, hasMarkup } from './markup.js';
import { fileLinksIn } from './filelinks.js';
import { statusLine, untilText } from '../../components/status.js';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, put, patch, del, onLive, uploadFile, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import PersonCard from '../../components/PersonCard.jsx';
import EmojiPicker from '../../components/EmojiPicker.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, PromptModal, useToast } from '../../components/ui.jsx';
import { whenText, laterChoices, ScheduleDialog } from '../../components/schedule.jsx';
import { useAuth } from '../../App.jsx';
import { useMentions, MENTION_RE, GROUP_WORD_RE, knownGroupWords } from '../../components/mentions.jsx';
import { addToTasksWithToast, titleFromText } from '../tasks/addtask.js';
import { isPaused } from '../../pause.js';

export default function Chat() {
  const { channelId } = useParams();
  const [params, setParams] = useSearchParams();
  const jumpTo = params.get('msg'); // a message to show (from search), with its thread if it's a reply
  const jumpThread = params.get('thread');
  const [search, setSearch] = useState(null); // { q, results }
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [channels, setChannels] = useState([]);
  const [online, setOnline] = useState([]);
  const [people, setPeople] = useState([]);
  const [messages, setMessages] = useState([]);
  const [pins, setPins] = useState([]); // this conversation's pinned messages
  const [pinsOpen, setPinsOpen] = useState(false);
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
  const [mentioned, setMentioned] = useState({}); // conversations where someone @mentioned you since you read them
  const mention = useMentions(box, text, setText, { groups: true });
  const [forwarding, setForwarding] = useState(null); // the message being forwarded
  const [threadId, setThreadId] = useState(null); // the message whose thread is open beside the conversation
  const [dialog, setDialog] = useState(false);
  const scroller = useRef();
  const stick = useRef(true);

  const loadChannels = () => get('/chat/channels').then(({ channels, online }) => {
    setChannels(channels); setOnline(online);
    setUnread(Object.fromEntries(channels.map((c) => [c.id, c.id === channelIdRef.current ? 0 : c.unread || 0])));
    setMentioned(Object.fromEntries(channels.map((c) => [c.id, c.id !== channelIdRef.current && c.mentions > 0])));
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
  useEffect(() => onLive((m) => { if (m.type === 'status-changed') get('/users/directory').then(setPeople).catch(() => {}); }), []);
  const statusFor = (userId) => people.find((p) => p.id === userId)?.status || null;
  const pausedFor = (userId) => { const u = people.find((p) => p.id === userId)?.paused_until; return u && u > Date.now() ? u : null; };

  const current = channels.find((c) => c.id === channelId);
  useEffect(() => {
    if (!channelId && channels.length) navigate(`/chat/${channels[0].id}`, { replace: true });
  }, [channelId, channels, navigate]);

  useEffect(() => {
    if (!channelId) return;
    setMessages([]);
    stick.current = true;
    setUnread((u) => ({ ...u, [channelId]: 0 }));
    setMentioned((x) => ({ ...x, [channelId]: false }));
    setEditingId(null); setFiles([]); setThreadId(null);
    if (jumpTo) stick.current = false;
    get(`/chat/channels/${channelId}/messages${jumpTo ? `?around=${encodeURIComponent(jumpTo)}` : ''}`).then((list) => {
      setMessages(list); markRead(channelId);
      if (jumpTo) {
        if (jumpThread) setThreadId(jumpThread);
        requestAnimationFrame(() => {
          const el = scroller.current?.querySelector(`[data-mid="${jumpTo}"]`);
          el?.scrollIntoView({ block: 'center' });
          el?.classList.add('found');
          setTimeout(() => el?.classList.remove('found'), 4000);
        });
      }
    }).catch((e) => toast(e.message, 'error'));
  }, [channelId, jumpTo, jumpThread, toast]);
  const runSearch = async (q) => {
    if (!q.trim()) { setSearch(null); return; }
    try { setSearch({ q, results: await get(`/chat/search?q=${encodeURIComponent(q)}`) }); } catch (e) { toast(e.message, 'error'); }
  };
  const openResult = (r) => {
    setSearch(null);
    const target = r.parent_id || r.id;
    navigate(`/chat/${r.channel_id}?msg=${target}${r.parent_id ? `&thread=${r.parent_id}` : ''}`);
  };

  const loadPins = useCallback(() => {
    if (!channelId) { setPins([]); return; }
    get(`/chat/channels/${channelId}/pins`).then(setPins).catch(() => setPins([]));
  }, [channelId]);
  useEffect(() => { loadPins(); setPinsOpen(false); }, [loadPins]);
  useEffect(() => onLive((m) => { if (m.type === 'pins-changed' && m.channel_id === channelId) loadPins(); }), [channelId, loadPins]);
  // Direct messages: when the other person last read the conversation ("Seen" under what you sent).
  const [seenAt, setSeenAt] = useState(null);
  const isDm = !!channels.find((c) => c.id === channelId)?.dm_key;
  useEffect(() => { setSeenAt(null); if (channelId && isDm) get(`/chat/channels/${channelId}/seen`).then((r) => setSeenAt(r.read_at)).catch(() => {}); }, [channelId, isDm]);
  useEffect(() => onLive((m) => { if (m.type === 'chat-seen' && m.channel_id === channelId) setSeenAt((t) => Math.max(t || 0, m.read_at)); }), [channelId]);
  const pin = (m, on) => post(`/chat/messages/${m.id}/pin`, { pinned: on }).then(() => toast(on ? 'Pinned to the conversation' : 'Unpinned')).catch((e) => toast(e.message, 'error'));

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
    } else if (m.type === 'chat-mention') {
      // Thread replies aren't in the conversation itself, so they need a notice unless that thread is open.
      const seen = m.channel_id === channelId && !document.hidden && (!m.parent_id || m.parent_id === threadId);
      if (!seen) {
        if (m.channel_id !== channelId) setMentioned((x) => ({ ...x, [m.channel_id]: true }));
        if (!isPaused()) toast(`${m.from} mentioned you: ${m.text}`, 'info', { action: { label: 'Open', onClick: () => { navigate(`/chat/${m.channel_id}`); if (m.parent_id) setTimeout(() => setThreadId(m.parent_id), 0); } } });
      }
    } else if (m.type === 'chat-read') {
      setUnread((u) => ({ ...u, [m.channel_id]: 0 }));
      setMentioned((x) => ({ ...x, [m.channel_id]: false }));
    } else if (m.type === 'message-deleted') {
      setMessages((list) => list.filter((x) => x.id !== m.id));
      setThreadId((t) => (t === m.id ? null : t));
    } else if (m.type === 'chat-unread') {
      loadChannels();
    } else if (m.type === 'channels-changed' || m.type === 'live-connected') {
      loadChannels();
    }
  }), [channelId, threadId]);

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

  // Your reminders about messages (shown on them), kept up to date live.
  const [reminders, setReminders] = useState(new Map());
  const loadReminders = useCallback(() => get('/chat/reminders').then((l) => setReminders(new Map(l.map((x) => [x.message_id, x.at])))).catch(() => {}), []);
  useEffect(() => { loadReminders(); }, [loadReminders]);
  useEffect(() => onLive((m) => { if (m.type === 'chat-reminders') loadReminders(); }), [loadReminders]);

  // Messages you've saved for later (yours alone), kept up to date live.
  const [saved, setSaved] = useState([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const loadSaved = useCallback(() => get('/chat/saved').then(setSaved).catch(() => {}), []);
  useEffect(() => { loadSaved(); }, [loadSaved]);
  useEffect(() => onLive((m) => { if (m.type === 'chat-saved') loadSaved(); }), [loadSaved]);
  useEffect(() => { setSavedOpen(false); }, [channelId]); // picking a conversation leaves the list
  const savedIds = new Set(saved.map((x) => x.message_id));
  const setSave = (id, on) => put(`/chat/messages/${id}/saved`, { saved: on }).then(() => { loadSaved(); toast(on ? 'Saved for later (🔖 Saved in the list)' : 'Removed from Saved'); }).catch((e) => toast(e.message, 'error'));

  // Messages you've scheduled here, soonest first (live: they go when sent).
  const [scheduled, setScheduled] = useState([]);
  const [pickingTime, setPickingTime] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const loadScheduled = useCallback(() => { if (channelId) get(`/chat/scheduled?channel=${channelId}`).then(setScheduled).catch(() => {}); }, [channelId]);
  useEffect(() => { setScheduled([]); loadScheduled(); }, [loadScheduled]);
  useEffect(() => onLive((m) => { if (m.type === 'chat-scheduled' && m.channel_id === channelId) loadScheduled(); }), [channelId, loadScheduled]);
  async function scheduleAt(at) {
    const body = text.trim();
    if ((!body && !files.length) || uploading) return;
    try {
      await post(`/chat/channels/${channelId}/scheduled`, { body, files: files.map((f) => f.id), send_at: at });
      setText(''); setFiles([]);
      toast(`Scheduled for ${whenText(at)}`);
      loadScheduled();
    } catch (err) { toast(err.message, 'error'); }
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
      checkLinkAccess(channelId, body, toast, user.org_name);
    } catch (err) { toast(err.message, 'error'); setText(body); setFiles(sending); }
  }

  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [pollOpen, setPollOpen] = useState(false);
  // A video meeting for this conversation: post its link here, then go to it.
  async function startMeeting() {
    try {
      const m = await post('/meet', { title: current?.dm_key ? '' : current?.name || '' });
      const msg = await post(`/chat/channels/${channelId}/messages`, { body: `📹 Started a video meeting: ${location.origin}/meet/${m.code}`, files: [] });
      setMessages((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg]));
      window.open(`/meet/${m.code}`, '_blank', 'noopener');
    } catch (err) { toast(err.message, 'error'); }
  }
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

  const publicChannels = channels.filter((c) => !c.dm_key && !c.archived_at);
  const archivedChannels = channels.filter((c) => !c.dm_key && c.archived_at);
  const [showArchived, setShowArchived] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canManage = (c) => c && !c.dm_key && (c.created_by === user.id || user.is_admin);
  const dms = channels.filter((c) => c.dm_key);
  const title = current ? (current.dm_key ? (current.dm_name || 'Notes to self') + (current.dm_org ? ` (${current.dm_org})` : '') : `# ${current.name}`) : '';

  return (
    <div className="chat">
      <aside className="subnav">
        <form className="chat-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(new FormData(e.currentTarget).get('q')); }}>
          <Icon name="search" size={18} />
          <input name="q" type="search" placeholder="Search messages" aria-label="Search messages" onChange={(e) => { if (!e.target.value) setSearch(null); }} />
        </form>
        <button type="button" className={`subnav-item ${savedOpen ? 'active' : ''}`} onClick={() => { setSearch(null); setSavedOpen(true); }}><span className="hash" aria-hidden="true">🔖</span><span className="grow">Saved</span>{saved.length > 0 && <span className="count">{saved.length}</span>}</button>
        <div className="subnav-title row">Channels<div className="grow" /><button className="icon-btn" aria-label="New channel" onClick={() => setDialog(true)}><Icon name="plus" size={18} /></button></div>
        {[...publicChannels, ...(showArchived ? archivedChannels : [])].map((c) => (
          <button key={c.id} className={`subnav-item ${c.id === channelId ? 'active' : ''} ${c.archived_at ? 'archived' : ''} ${c.muted ? 'muted' : ''}`} onClick={() => navigate(`/chat/${c.id}`)}>
            <span className="hash" aria-label={c.private ? 'Private channel' : undefined}>{c.private ? '🔒' : '#'}</span><span className="grow ellipsis">{c.name}</span>{c.muted && <span className="muted-mark" aria-label="Muted" title="Muted">🔕</span>}{mentioned[c.id] && <span className="badge at" aria-label="You were mentioned">@</span>}{unread[c.id] > 0 && <span className={`badge ${c.muted ? 'quiet' : ''}`}>{unread[c.id]}</span>}
          </button>
        ))}
        {archivedChannels.length > 0 && <button type="button" className="link-btn small archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide' : 'Show'} archived ({archivedChannels.length})</button>}
        <div className="subnav-title">Direct messages</div>
        {dms.map((c) => (
          <button key={c.id} className={`subnav-item ${c.id === channelId ? 'active' : ''} ${c.muted ? 'muted' : ''}`} onClick={() => navigate(`/chat/${c.id}`)}>
            <Avatar name={c.dm_name || user.name} size={20} userId={c.dm_user_id || user.id} /><span className="grow ellipsis">{c.dm_name || 'Notes to self'}{c.dm_org && <span className="muted small"> · {c.dm_org}</span>}{statusFor(c.dm_user_id) && <span className="dm-status" title={statusLine(statusFor(c.dm_user_id))}> {statusFor(c.dm_user_id).emoji || '💬'}</span>}{pausedFor(c.dm_user_id) && <span className="dm-status" aria-label="Notifications paused" title={`Notifications paused until ${whenText(pausedFor(c.dm_user_id))}`}> 🔕</span>}</span>{c.muted && <span className="muted-mark" aria-label="Muted" title="Muted">🔕</span>}{mentioned[c.id] && <span className="badge at" aria-label="You were mentioned">@</span>}{unread[c.id] > 0 && <span className={`badge ${c.muted ? 'quiet' : ''}`}>{unread[c.id]}</span>}
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
        {savedOpen && !search ? (
          <div className="chat-results">
            <div className="chat-head"><h1 className="grow">Saved</h1><button type="button" className="icon-btn" aria-label="Close saved" onClick={() => setSavedOpen(false)}><Icon name="close" /></button></div>
            {!saved.length ? <Empty icon="chat" title="Nothing saved yet">Hover over a message and choose 🔖 to keep it here for later. Only you see what you save.</Empty> : (
              <ul aria-label="Saved messages">
                {saved.map((r) => (
                  <li key={r.message_id} className="row">
                    <button type="button" className="chat-result grow" onClick={() => { setSavedOpen(false); openResult({ id: r.message_id, channel_id: r.channel_id, parent_id: r.parent_id }); }}>
                      <span className="muted small">{r.dm ? 'Direct message' : `#${r.channel}`}{r.parent_id ? ' · in a thread' : ''} · {new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      <span><strong>{r.author || 'Someone'}</strong> {r.body || (r.files ? `📎 ${r.files} file${r.files === 1 ? '' : 's'}` : '')}</span>
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Remove from Saved: ${(r.body || '').slice(0, 40)}`} title="Remove from Saved" onClick={() => setSave(r.message_id, false)}><Icon name="close" size={16} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : search ? (
          <div className="chat-results">
            <div className="chat-head"><h1 className="grow">Results for “{search.q}”</h1><button type="button" className="icon-btn" aria-label="Close search" onClick={() => setSearch(null)}><Icon name="close" /></button></div>
            {!search.results.length ? <Empty icon="search" title="No messages found" /> : (
              <ul aria-label="Search results">
                {search.results.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="chat-result" onClick={() => openResult(r)}>
                      <span className="muted small">{r.private ? '🔒 ' : ''}{r.where}{r.parent_id ? ' · in a thread' : ''} · {new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      <span><strong>{r.user_name || 'Someone'}</strong> <Highlighted text={r.body} words={search.q} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : !current ? <Empty icon="chat" title="Pick a conversation" /> : <>
          <div className="chat-head">
            <div className="grow" style={{ minWidth: 0 }}>
              <h1>{current.private && !current.dm_key ? `🔒 ${current.name}` : title}</h1>
              {current.dm_key && statusFor(current.dm_user_id) && <p className="chat-topic person-status" aria-label="Their status">{statusLine(statusFor(current.dm_user_id))}{statusFor(current.dm_user_id).until ? ` · ${untilText(statusFor(current.dm_user_id).until)}` : ''}</p>}
              {!current.dm_key && (current.topic ? <p className="chat-topic muted small" title={current.topic}>{current.topic}</p> : !current.archived_at && <button type="button" className="link-btn small" onClick={() => setSettingsOpen(true)}>Add a topic</button>)}
            </div>
            {!current.dm_key && <span className="muted small">{current.private ? `${current.member_count} member${current.member_count === 1 ? '' : 's'}` : 'Everyone'}</span>}
            <button type="button" className={`btn small ${current.muted ? 'primary' : ''}`} aria-pressed={!!current.muted} aria-label={current.muted ? 'Unmute conversation' : 'Mute conversation'}
              title={current.muted ? 'Muted: messages here don’t add to Chat’s unread count (mentions still do). Click to unmute.' : 'Mute: messages here stop adding to Chat’s unread count (mentions still do)'}
              onClick={async () => { try { await post(`/chat/channels/${current.id}/mute`, { muted: !current.muted }); await loadChannels(); toast(current.muted ? 'Unmuted' : 'Muted: only mentions will add to your unread count'); } catch (e) { toast(e.message, 'error'); } }}>{current.muted ? '🔕' : '🔔'}</button>
            <div className="pins-wrap">
              <button type="button" className={`btn small ${pinsOpen ? 'primary' : ''}`} aria-expanded={pinsOpen} aria-label={`Pinned messages (${pins.length})`} title="Pinned messages" onClick={() => setPinsOpen(!pinsOpen)}>📌 {pins.length || ''}</button>
              {pinsOpen && (
                <div className="pins-panel" role="dialog" aria-label="Pinned messages">
                  <div className="row"><strong className="grow">Pinned</strong><button type="button" className="icon-btn" aria-label="Close pinned messages" onClick={() => setPinsOpen(false)}><Icon name="close" size={16} /></button></div>
                  {!pins.length ? <p className="muted small">Nothing pinned yet. Pin a message (📌 on it) to keep it here for everyone.</p> : (
                    <ul>
                      {pins.map((m) => (
                        <li key={m.id}>
                          <button type="button" className="pin-item" onClick={() => { setPinsOpen(false); navigate(`/chat/${m.channel_id}?msg=${m.id}`); }}>
                            <span className="small"><strong>{m.user_name || 'Deleted user'}</strong> <span className="muted">{timeOrDay(m.created_at)}</span></span>
                            <span className="pin-text">{m.body || (m.files?.length ? `📎 ${m.files.map((f) => f.name).join(', ')}` : '')}</span>
                            <span className="muted small">Pinned by {m.pinned_by_name || 'someone'}</span>
                          </button>
                          {!current.archived_at && <button type="button" className="link-btn small" onClick={() => pin(m, false)}>Unpin</button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {!current.dm_key && <button type="button" className="icon-btn" aria-label="Channel settings" title="Channel settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>}
          </div>
          <div className="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {messages.length === 0 && <Empty icon="chat" title="No messages yet">Say hello 👋</Empty>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const lastMine = current.dm_key && m.user_id === user.id && !messages.slice(i + 1).some((x) => x.user_id === user.id);
              const grouped = prev && prev.user_id === m.user_id && m.created_at - prev.created_at < 5 * 60e3;
              const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
              return (
                <div key={m.id}>
                  {newDay && <div className="day-sep"><span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>}
                  <Message m={m} grouped={grouped && !newDay} user={user} reminder={reminders.get(m.id)} saved={savedIds.has(m.id)} onSave={(on) => setSave(m.id, on)} editing={editingId === m.id} editText={editText} setEditText={setEditText}
                    onStartEdit={() => { setEditingId(m.id); setEditText(m.body); }} onSaveEdit={() => saveEdit(m)} onCancelEdit={() => setEditingId(null)}
                    onReact={(e) => react(m, e)} onThread={() => setThreadId(m.id)} onPin={current.archived_at ? null : () => pin(m, !m.pinned_at)} onForward={m.poll ? null : () => setForwarding(m)} onMarkUnread={async () => {
                      try { await post(`/chat/messages/${m.id}/unread`); navigate('/chat'); toast(`Marked unread from ${m.user_name || 'this message'}’s message`); } catch (e) { toast(e.message, 'error'); }
                    }} onDelete={() => del(`/chat/messages/${m.id}`).catch((e) => toast(e.message, 'error'))} />
                  {lastMine && seenAt >= m.created_at && current.dm_user_id !== user.id && <div className="seen-mark muted small" title={`Seen ${new Date(seenAt).toLocaleString()}`}>Seen</div>}
                </div>
              );
            })}
          </div>
          {(files.length > 0 || uploading > 0) && (
            <ul className="pending-files" aria-label="Files to send">
              {files.map((f) => <li key={f.id}>{/^audio\//.test(f.mime || '') ? <audio controls src={`/api/files/${f.id}/raw`} aria-label={`Recording: ${f.name}`} /> : <><Icon name="attach" size={14} /> {f.name}</>} <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><Icon name="close" size={14} /></button></li>)}
              {uploading > 0 && <li className="muted">Uploading {uploading}…</li>}
            </ul>
          )}
          {!current.archived_at && current.can_post === false ? (
            <div className="banner archived-banner" role="note">📣 Only {(current.posters || []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean).join(', ') || 'some people'} (and admins) start conversations here. Reply in a thread to join in.</div>
          ) : current.archived_at ? (
            <div className="banner archived-banner">This channel is archived: it can be read but not written in.
              {canManage(current) && <button type="button" className="btn small" onClick={async () => { await patch(`/chat/channels/${current.id}`, { archived: false }); loadChannels(); }}>Unarchive</button>}</div>
          ) : <form className="composer" onSubmit={send} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); attach([...e.dataTransfer.files]); } }}>
            <EmojiPicker up className="icon-btn" onPick={insertEmoji} />
            <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files (or drop or paste them here)" onClick={() => fileInput.current.click()}><Icon name="attach" /></button>
            <VoiceRecorder onDone={(file) => attach([file])} />
            <button type="button" className="icon-btn" aria-label="Create a poll" title="Ask a question with options to vote on" onClick={() => setPollOpen(true)}>📊</button>
            <button type="button" className="icon-btn" aria-label="Start a video meeting" title="Start a video meeting and share its link here" onClick={startMeeting}><Icon name="video" /></button>
            <input ref={fileInput} type="file" multiple hidden aria-label="Files to attach" onChange={(e) => { attach([...e.target.files]); e.target.value = ''; }} />
            <textarea ref={box} rows={1} value={text} placeholder={`Message ${title}`} aria-label="Message" title="*bold*  _italic_  ~strike~  `code`  ```code block```  > quote" onChange={(e) => { setText(e.target.value); mention.track(e.target.value, e.target.selectionStart); }}
              onPaste={(e) => { const pasted = [...(e.clipboardData?.files || [])]; if (pasted.length) { e.preventDefault(); attach(pasted); } }}
              onKeyDown={(e) => { if (mention.keyDown(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
            {mention.list}
            <Menu align="right" trigger={(p) => <button type="button" className="icon-btn" aria-label="Schedule message" title="Send later" disabled={(!text.trim() && !files.length) || uploading > 0} {...p}><Icon name="clock" /></button>}
              items={[...laterChoices().map(([label, at]) => ({ label: `${label} · ${whenText(at)}`, onClick: () => scheduleAt(at) })), '-', { label: 'Pick date and time…', icon: 'calendar', onClick: () => setPickingTime(true) }]} />
            <button className="icon-btn send" aria-label="Send" disabled={(!text.trim() && !files.length) || uploading > 0}><Icon name="send" /></button>
          </form>}
          {scheduled.length > 0 && !current.archived_at && (
            <button type="button" className="link-btn small scheduled-bar" onClick={() => setScheduledOpen(true)}>
              🕒 {scheduled.length} scheduled message{scheduled.length === 1 ? '' : 's'}{scheduled.some((x) => x.error) ? ' (one couldn’t be sent)' : ` · next ${whenText(scheduled[0].send_at)}`}
            </button>
          )}
        </>}
      </section>
      {current && threadId && <Thread key={threadId} id={threadId} channelId={channelId} user={user} onClose={() => setThreadId(null)} />}
      {pickingTime && <ScheduleDialog title="Schedule message" confirm="Schedule" withinYear note={(at) => `It will be sent ${whenText(at)}, as if you sent it then, even if Workspace isn’t open.`}
        onClose={() => setPickingTime(false)} onPick={(at) => { setPickingTime(false); scheduleAt(at); }} />}
      {scheduledOpen && <ScheduledMessages list={scheduled} onClose={() => setScheduledOpen(false)} onChanged={loadScheduled} />}
      {forwarding && <ForwardDialog message={forwarding} channels={channels} currentId={channelId} onClose={() => setForwarding(null)} onSent={() => setForwarding(null)} />}
      {pollOpen && current && <PollDialog onClose={() => setPollOpen(false)} onSubmit={async (poll) => {
        stick.current = true;
        const msg = await post(`/chat/channels/${channelId}/messages`, { poll });
        setMessages((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg]));
        setPollOpen(false);
      }} />}
      {dialog === 'email' && <PromptModal title="Message someone at another company" label="Their email address" confirm="Start chat" onClose={() => setDialog(false)}
        onSubmit={async (email) => { const p = await get(`/users/lookup?email=${encodeURIComponent(email)}`); await openDm(p.id); }} />}
      {dialog === true && <NewChannel people={people.filter((p) => p.id !== user.id)} onClose={() => setDialog(false)}
        onMade={async (id) => { setDialog(false); await loadChannels(); navigate(`/chat/${id}`); }} />}
      {settingsOpen && current && !current.dm_key && <ChannelSettings channel={current} me={user} canManage={canManage(current)} people={people} onClose={() => setSettingsOpen(false)}
        onChanged={loadChannels} onLeft={async () => { setSettingsOpen(false); await loadChannels(); navigate('/chat'); }} />}
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
  const mention = useMentions(box, text, setText, { groups: true });
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
    try { const msg = await post(`/chat/channels/${channelId}/messages`, { body, parent_id: id }); setReplies((list) => (list.some((x) => x.id === msg.id) ? list : [...list, msg])); checkLinkAccess(channelId, body, toast, user.org_name); }
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
        <textarea ref={box} rows={1} value={text} placeholder="Reply…" aria-label="Reply" onChange={(e) => { setText(e.target.value); mention.track(e.target.value, e.target.selectionStart); }}
          onKeyDown={(e) => { if (mention.keyDown(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
        {mention.list}
        <button className="icon-btn send" aria-label="Send reply" disabled={!text.trim()}><Icon name="send" /></button>
      </form>
    </aside>
  );
}

/** One message: text (or the box to change it), files, reactions, its thread, and hover actions. */
function Message({ m, grouped, user, editing, editText, setEditText, onStartEdit, onSaveEdit, onCancelEdit, onReact, onThread, onPin, onForward, onMarkUnread, onDelete, reminder, saved, onSave }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [card, setCard] = useState(false); // the author's card
  const toTask = () => addToTasksWithToast(toast, navigate, {
    title: titleFromText(m.body) || (m.poll ? m.poll.question : 'Chat message'),
    link: { url: `/chat/${m.channel_id}?msg=${m.id}${m.parent_id ? `&thread=${m.parent_id}` : ''}`, label: `Chat message from ${m.user_name || 'someone'}` },
  });
  const remind = async (at) => {
    try { await post(`/chat/messages/${m.id}/remind`, { at }); toast(at ? `I'll remind you ${whenText(at)}` : 'Reminder removed'); } catch (e) { toast(e.message, 'error'); }
  };
  const soon = [['In 20 minutes', Date.now() + 20 * 60e3], ['In 1 hour', Date.now() + 36e5], ...laterChoices()];
  return (
    <div className={`msg ${grouped ? 'grouped' : ''} ${m.pinned_at ? 'pinned' : ''}`} data-mid={m.id}>
      {grouped ? <span className="msg-gutter" /> : m.user_id ? <button type="button" className="avatar-btn" aria-label={`About ${m.user_name}`} onClick={() => setCard(true)}><Avatar name={m.user_name || 'Deleted user'} size={36} userId={m.user_id} /></button> : <Avatar name="Deleted user" size={36} />}
      {card && <PersonCard userId={m.user_id} onClose={() => setCard(false)} />}
      <div className="msg-body">
        {!grouped && <div className="msg-meta">{m.user_id ? <button type="button" className="link-btn msg-author" onClick={() => setCard(true)}><strong>{m.user_name}</strong></button> : <strong>Deleted user</strong>} <span className="muted small">{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>}
        {m.pinned_at && <div className="msg-pinned muted small">📌 Pinned by {m.pinned_by_name || 'someone'}</div>}
        {reminder && <div className="msg-reminder muted small">⏰ I'll remind you {whenText(reminder)} <button type="button" className="link-btn small" onClick={() => remind(null)}>Cancel</button></div>}
        {picking && <ScheduleDialog title="Remind me" confirm="Remind me" withinYear note={(at) => `You'll get a notification ${whenText(at)}, linking back to this message.`}
          onClose={() => setPicking(false)} onPick={(at) => { setPicking(false); remind(at); }} />}
        {editing ? (
          <form className="msg-edit" onSubmit={(e) => { e.preventDefault(); onSaveEdit(); }}>
            <textarea autoFocus aria-label="Change the message" value={editText} rows={Math.min(6, editText.split('\n').length)} onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(); } else if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); } }} />
            <span className="muted small">Enter to save · Esc to cancel</span>
          </form>
        ) : m.poll ? <Poll m={m} user={user} />
          : m.body && <div className="msg-text"><Formatted text={m.body} me={user.username} />{m.edited_at && <span className="muted small edited" title={`Edited ${new Date(m.edited_at).toLocaleString()}`}> (edited)</span>}<MeetJoin body={m.body} /></div>}
        {m.forwarded && (
          <blockquote className="msg-forwarded" aria-label={`Forwarded message from ${m.forwarded.name}`}>
            <div className="muted small">↪ Forwarded · <strong>{m.forwarded.name}</strong>{m.forwarded.where ? ` in #${m.forwarded.where}` : ''} · {new Date(m.forwarded.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            {m.forwarded.body && <div className="msg-text"><Formatted text={m.forwarded.body} me={user.username} /></div>}
            <FileCards text={m.forwarded.body} />
          </blockquote>
        )}
        {!editing && <FileCards text={m.body} />}
        {!editing && m.preview && (
          <a className="link-preview" href={m.preview.url} target="_blank" rel="noopener noreferrer" aria-label={`Link: ${m.preview.title}`}>
            <span className="link-site small muted">{m.preview.site}</span>
            <strong>{m.preview.title}</strong>
            {m.preview.description && <span className="small">{m.preview.description}</span>}
          </a>
        )}
        {m.files?.length > 0 && (
          <div className="msg-files">
            {m.files.map((f) => (/^audio\/(webm|ogg|mp4|mpeg|wav)$/.test(f.mime)
              ? <audio key={f.id} className="msg-voice" controls preload="metadata" src={`/api/chat/messages/${m.id}/files/${f.id}`} aria-label={f.name.startsWith('Voice message') ? `Voice message from ${m.user_name || 'someone'}` : f.name} />
              : /^image\/(png|jpeg|gif|webp)$/.test(f.mime)
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
        <Menu align="right" trigger={(p) => <button type="button" className="icon-btn" aria-label="Remind me about this" title="Remind me about this" {...p}><Icon name="clock" size={16} /></button>}
          items={[...soon.map(([label, at]) => ({ label: `${label} · ${whenText(at)}`, onClick: () => remind(at) })), '-', { label: 'Pick date and time…', icon: 'calendar', onClick: () => setPicking(true) }]} />
        {onSave && <button type="button" className={`icon-btn ${saved ? 'on' : ''}`} aria-pressed={!!saved} aria-label={saved ? 'Remove from Saved' : 'Save for later'} title={saved ? 'Saved (click to remove)' : 'Save for later'} onClick={() => onSave(!saved)}>🔖</button>}
        {onMarkUnread && m.user_id !== user.id && <button type="button" className="icon-btn" aria-label="Mark unread from here" title="Mark unread from here" onClick={onMarkUnread}><Icon name="markunread" size={16} /></button>}
        {onForward && <button type="button" className="icon-btn" aria-label="Forward" title="Forward to another conversation" onClick={onForward}><Icon name="forward" size={16} /></button>}
        <button type="button" className="icon-btn" aria-label="Add to Tasks" title="Add to Tasks" onClick={toTask}><Icon name="check" size={16} /></button>
        {onPin && !m.parent_id && <button type="button" className="icon-btn" aria-label={m.pinned_at ? 'Unpin message' : 'Pin message'} title={m.pinned_at ? 'Unpin' : 'Pin to the conversation'} onClick={onPin}>📌</button>}
        {m.user_id === user.id && !m.poll && <button type="button" className="icon-btn" aria-label="Edit message" onClick={onStartEdit}><Icon name="edit" size={16} /></button>}
        {(m.user_id === user.id || user.is_admin) && (
          <button className="icon-btn" aria-label="Delete message" onClick={onDelete}><Icon name="trash" size={16} /></button>
        )}
      </div>
    </div>
  );
}

/** A poll in a message: the question, a bar per option with who chose it, and voting (live for everyone). */
/**
 * After sending links to Drive files: if some people in the conversation can't open one, say so;
 * when it's yours, offer to share it with them (in a company-wide channel: with the whole company).
 */
async function checkLinkAccess(channelId, body, toast, orgName) {
  for (const { id } of fileLinksIn(body)) {
    let gap, file;
    try { [gap, file] = await Promise.all([get(`/chat/channels/${channelId}/missing-access?file=${id}`), get(`/files/${id}`)]); } catch { continue; }
    if (!gap.total) continue;
    const who = gap.everyone ? `${gap.total} ${gap.total === 1 ? 'person' : 'people'} here` : gap.people.map((p) => p.name).join(', ');
    if (!gap.can_share) { toast(`${who} can't open “${file.name}”. Ask its owner to share it.`, 'info', { duration: 10000 }); continue; }
    const share = gap.everyone
      ? { label: `Share with everyone at ${orgName}`, run: () => put(`/files/${id}/company`, { role: 'viewer' }), done: `Everyone at ${orgName} can view “${file.name}”` }
      : { label: 'Share with them', run: async () => {
        const now = await get(`/files/${id}/shares`);
        await put(`/files/${id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), ...gap.people.map((p) => ({ user_id: p.id, role: 'viewer' }))] });
      }, done: `Shared “${file.name}” with ${who} (can view)` };
    toast(`${who} can't open “${file.name}”`, 'info', { duration: 15000, action: { label: share.label, onClick: () => share.run().then(() => toast(share.done)).catch((e) => toast(e.message, 'error')) } });
  }
}

/** Forward a message: pick a conversation you can write in, add a note if you like. */
function ForwardDialog({ message, channels, currentId, onClose, onSent }) {
  const toast = useToast();
  const open = channels.filter((c) => !c.archived_at);
  const [to, setTo] = useState(open.find((c) => c.id !== currentId)?.id || open[0]?.id || '');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const name = (c) => (c.dm_key ? `${c.dm_name || 'Notes to self'}${c.dm_org ? ` (${c.dm_org})` : ''}` : `# ${c.name}`);
  async function submit(e) {
    e.preventDefault();
    try {
      await post(`/chat/messages/${message.id}/forward`, { channel_id: to, body: note });
      onSent(to);
      toast(`Forwarded to ${name(open.find((c) => c.id === to))}`);
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title="Forward message" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <blockquote className="msg-forwarded"><div className="muted small">{message.forwarded ? message.forwarded.name : message.user_name}</div>
          <div className="ellipsis">{(message.body || message.forwarded?.body || (message.files?.length ? `📎 ${message.files.map((f) => f.name).join(', ')}` : '')).slice(0, 200)}</div></blockquote>
        <label className="field"><span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} required>
            {open.map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
          </select>
        </label>
        <label className="field"><span>Add a message (optional)</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={8000} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to}>Forward</button></div>
      </form>
    </Modal>
  );
}

function Poll({ m, user }) {
  const toast = useToast();
  const p = m.poll;
  const mine = p.options.filter((o) => o.votes.some((v) => v.id === user.id)).map((o) => o.id);
  const most = Math.max(1, ...p.options.map((o) => o.votes.length));
  const closed = !!p.closed_at;
  const vote = (id) => {
    const next = p.multi ? (mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id]) : (mine.includes(id) ? [] : [id]);
    post(`/chat/messages/${m.id}/vote`, { options: next }).catch((e) => toast(e.message, 'error'));
  };
  return (
    <div className="poll" role="group" aria-label={`Poll: ${p.question}`}>
      <div className="poll-q"><strong>📊 {p.question}</strong></div>
      <div className="muted small">{closed ? 'Closed' : p.multi ? 'Choose any' : 'Choose one'} · {p.voters} {p.voters === 1 ? 'person' : 'people'} voted</div>
      <ul className="poll-options">
        {p.options.map((o) => {
          const chosen = mine.includes(o.id);
          const names = o.votes.map((v) => v.name).join(', ');
          return (
            <li key={o.id}>
              <button type="button" className={`poll-option ${chosen ? 'chosen' : ''}`} disabled={closed} aria-pressed={chosen}
                aria-label={`${o.text}: ${o.votes.length} vote${o.votes.length === 1 ? '' : 's'}`} title={names || 'No votes yet'} onClick={() => vote(o.id)}>
                <span className="poll-bar" style={{ width: `${(o.votes.length / most) * 100}%` }} aria-hidden="true" />
                <span className="poll-mark" aria-hidden="true">{chosen ? (p.multi ? '☑' : '◉') : (p.multi ? '☐' : '○')}</span>
                <span className="grow poll-text">{o.text}</span>
                <span className="poll-count">{o.votes.length}</span>
              </button>
              {names && <div className="muted small poll-names">{names}</div>}
            </li>
          );
        })}
      </ul>
      {m.user_id === user.id && (
        <button type="button" className="link-btn small" onClick={() => post(`/chat/messages/${m.id}/poll/close`, { closed: !closed }).catch((e) => toast(e.message, 'error'))}>{closed ? 'Reopen poll' : 'Close poll'}</button>
      )}
    </div>
  );
}

/** Your scheduled messages in a conversation: when, what, and Send now or Delete. */
function ScheduledMessages({ list, onClose, onChanged }) {
  const toast = useToast();
  const run = (fn, msg) => async () => { try { await fn(); toast(msg); onChanged(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title="Scheduled messages" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!list.length ? <p className="muted">Nothing is waiting to be sent here.</p> : (
        <ul className="scheduled-list">
          {list.map((m) => (
            <li key={m.id}>
              <div className="muted small">{m.error ? <span className="error">Couldn’t be sent: {m.error}</span> : `Sends ${whenText(m.send_at)}`}</div>
              <div className="scheduled-text">{m.body || (m.files.length ? `📎 ${m.files.map((f) => f.name).join(', ')}` : '')}</div>
              <div className="row">
                <button type="button" className="btn small" onClick={run(() => post(`/chat/scheduled/${m.id}/send`, {}), 'Sent')}>Send now</button>
                <button type="button" className="btn small danger" onClick={run(() => del(`/chat/scheduled/${m.id}`), 'Deleted')}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Ask a question: 2–10 options, one choice or several. */
function PollDialog({ onClose, onSubmit }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try { await onSubmit({ question, options, multi }); } catch (err) { setError(err.message); }
  }
  return (
    <Modal title="Create a poll" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Question</span><input autoFocus required maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Where shall we have lunch?" /></label>
        {options.map((o, i) => (
          <div key={i} className="row">
            <label className="field grow"><span>Option {i + 1}</span><input maxLength={200} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} /></label>
            {options.length > 2 && <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>}
          </div>
        ))}
        {options.length < 10 && <button type="button" className="link-btn" onClick={() => setOptions([...options, ''])}>+ Add an option</button>}
        <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> People can choose more than one</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Post poll</button></div>
      </form>
    </Modal>
  );
}

// What each linked file is, fetched once per page (null: you can't open it, or it's gone).
const fileInfo = new Map();
const infoOf = (id) => {
  if (!fileInfo.has(id)) fileInfo.set(id, get(`/files/${id}`).catch(() => null));
  return fileInfo.get(id);
};
const OPEN = { doc: (id) => `/docs/${id}`, sheet: (id) => `/sheets/${id}`, slides: (id) => `/slides/${id}`, folder: (id) => `/drive/folder/${id}` };
const KIND_NAME = { doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', folder: 'Folder' };

/** Links to Workspace files in a message, shown as cards: what it is, whose, and a way in. */
function FileCards({ text }) {
  const links = fileLinksIn(text);
  const [info, setInfo] = useState({});
  useEffect(() => {
    let alive = true;
    for (const l of links) infoOf(l.id).then((f) => { if (alive) setInfo((x) => ({ ...x, [l.id]: f || false })); });
    return () => { alive = false; };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!links.length) return null;
  return (
    <div className="file-cards">
      {links.map((l) => {
        const f = info[l.id];
        if (f === undefined) return null;
        if (f === false) {
          return (
            <Link key={l.id} className="file-card none" to={`/access/${l.id}`}>
              <Icon name="lock" size={22} />
              <span className="grow"><strong>A file you can’t open</strong><span className="muted small">Ask for access</span></span>
            </Link>
          );
        }
        return (
          <Link key={l.id} className="file-card" to={OPEN[f.kind]?.(f.id) || `/drive`} aria-label={`${KIND_NAME[f.kind] || 'File'}: ${f.name}`}>
            <Icon name={f.kind === 'folder' ? 'folder' : f.kind} size={22} className={`ft ft-${f.kind}`} />
            <span className="grow"><strong>{f.name}</strong><span className="muted small">{KIND_NAME[f.kind] || 'File'} · {f.owner_name}{f.role === 'viewer' ? ' · you can view' : f.role === 'editor' ? ' · you can edit' : ''}</span></span>
          </Link>
        );
      })}
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
/** A message with its formatting (*bold*, _italic_, ~strike~, `code`, code blocks, quotes). */
export function Formatted({ text, me }) {
  if (!hasMarkup(text)) return <Linked text={text} me={me} />;
  const draw = (nodes, key) => nodes.map((n, i) => {
    const k = `${key}.${i}`;
    if (n.t === 'text') return <Linked key={k} text={n.v} me={me} />;
    if (n.t === 'code') return <code key={k} className="msg-inline-code">{n.v}</code>;
    const Tag = { b: 'strong', i: 'em', s: 's' }[n.t];
    return <Tag key={k}>{draw(n.c, k)}</Tag>;
  });
  const parts = blocks(text);
  return parts.map((b, i) => {
    const nl = i < parts.length - 1 && b.t === 'line' ? '\n' : '';
    if (b.t === 'code') return <pre key={i} className="msg-code">{b.v}</pre>;
    if (b.t === 'quote') return <blockquote key={i} className="msg-quote">{b.lines.map((l, j) => <span key={j}>{draw(l, `${i}.${j}`)}{j < b.lines.length - 1 ? '\n' : ''}</span>)}</blockquote>;
    return <span key={i}>{draw(b.c, String(i))}{nl}</span>;
  });
}

/** @a-group and @channel, highlighted (plain text otherwise). */
function groupWords(text, key) {
  const parts = String(text).split(GROUP_WORD_RE);
  if (parts.length === 1) return text;
  // split with two groups: [before, lead, word, before, lead, word, ...]
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    if (k % 3 === 2) out.push(knownGroupWords.has(parts[k].slice(1).toLowerCase()) ? <span key={`${key}g${k}`} className="mention group">{parts[k]}</span> : parts[k]);
    else if (parts[k]) out.push(parts[k]);
  }
  return out;
}

export function Linked({ text, me }) {
  return String(text).split(MENTION_RE).map((chunk, j) => (j % 2
    ? <span key={`m${j}`} className={`mention${me && chunk.slice(1).toLowerCase() === me.toLowerCase() ? ' me' : ''}`}>{chunk}</span>
    : chunk.split(LINK_RE).map((part, i) => {
      if (i % 2 === 0) return groupWords(part, `${j}-${i}`);
      return part.startsWith('/') ? <Link key={`${j}-${i}`} to={part}>{part}</Link> : <a key={`${j}-${i}`} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
    })));
}

/** A message with a meeting link gets a Join button (opens in a new tab, so the chat stays open). */
const MEET_RE = /\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/;
function MeetJoin({ body }) {
  const code = String(body || '').match(MEET_RE)?.[1];
  if (!code) return null;
  return <div><a className="btn small meet-join" href={`/meet/${code}`} target="_blank" rel="noreferrer"><Icon name="video" size={16} /> Join video meeting</a></div>;
}

/** A new channel: open to the company, or private to the people chosen. */
function NewChannel({ people, onClose, onMade }) {
  const [f, setF] = useState({ name: '', topic: '', private: false, members: new Set() });
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try { const c = await post('/chat/channels', { name: f.name, topic: f.topic, private: f.private, members: [...f.members] }); onMade(c.id); }
    catch (err) { setError(err.message); }
  }
  return (
    <Modal title="New channel" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Channel name</span><input autoFocus required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. marketing" /></label>
        <label className="field"><span>Topic (optional)</span><input maxLength={250} value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder="What it’s for" /></label>
        <label className="check"><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Private: only the people you choose can see it</label>
        {f.private && <PeoplePicker people={people} chosen={f.members} onChange={(members) => setF({ ...f, members })} />}
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create</button></div>
      </form>
    </Modal>
  );
}

function PeoplePicker({ people, chosen, onChange, label = 'Who can see it' }) {
  const [find, setFind] = useState('');
  const shown = people.filter((p) => `${p.name} ${p.username}`.toLowerCase().includes(find.toLowerCase()));
  const [groups, setGroups] = useState([]);
  useEffect(() => { get('/groups').then(setGroups).catch(() => {}); }, []);
  const known = new Set(people.map((p) => p.id));
  return (
    <fieldset className="people-pick">
      <legend className="muted small">{label}</legend>
      <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find people" aria-label="Find people" />
      {groups.some((g) => g.members.length) && (
        <div className="row wrap group-picks" role="group" aria-label="Add a group">
          {groups.filter((g) => g.members.length).map((g) => (
            <button key={g.id} type="button" className="btn small" onClick={() => onChange(new Set([...chosen, ...g.members.map((m) => m.id).filter((id) => known.has(id))]))}>+ {g.name} ({g.members.length})</button>
          ))}
        </div>
      )}
      <ul>
        {shown.map((p) => (
          <li key={p.id}><label className="check"><input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(p.id) : n.delete(p.id); onChange(n); }} />
            <Avatar name={p.name} size={22} userId={p.id} /> {p.name} <span className="muted small">{p.username}</span></label></li>
        ))}
      </ul>
    </fieldset>
  );
}

/** A channel's topic, name, privacy, members and archiving. */
/** Announcement channels: everyone posts, or only the people chosen (whoever made it and admins always can). */
function WhoPosts({ channel, people, onSave }) {
  const [some, setSome] = useState(!!channel.posters);
  const [chosen, setChosen] = useState(new Set(channel.posters || []));
  const changed = some !== !!channel.posters || (some && [...chosen].sort().join() !== [...(channel.posters || [])].sort().join());
  return (
    <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
      <legend><strong>Who can start conversations</strong></legend>
      <label className="check"><input type="radio" name="who-posts" checked={!some} onChange={() => setSome(false)} /> Everyone in the channel</label>
      <label className="check"><input type="radio" name="who-posts" checked={some} onChange={() => setSome(true)} /> Only some people (an announcement channel; everyone can still reply in threads and react)</label>
      {some && <PeoplePicker label="People who can post" people={people} chosen={chosen} onChange={setChosen} />}
      <div className="row"><button type="button" className="btn" disabled={!changed} onClick={() => onSave(some ? [...chosen] : null)}>Save</button></div>
    </fieldset>
  );
}

function ChannelSettings({ channel, me, canManage, people, onClose, onChanged, onLeft }) {
  const toast = useToast();
  const [topic, setTopic] = useState(channel.topic || '');
  const [name, setName] = useState(channel.name);
  const [members, setMembers] = useState(null);
  const [adding, setAdding] = useState(new Set());
  const [confirm, setConfirm] = useState(null);
  const general = !channel.created_by; // the company-wide channel
  const loadMembers = () => get(`/chat/channels/${channel.id}/members`).then(setMembers).catch(() => setMembers([]));
  useEffect(() => { if (channel.private) loadMembers(); }, [channel.id, channel.private]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = async (body, done) => { try { await patch(`/chat/channels/${channel.id}`, body); toast(done); onChanged(); } catch (e) { toast(e.message, 'error'); } };
  const memberIds = new Set((members || []).map((m) => m.id));
  return (
    <Modal wide title={`#${channel.name}`} onClose={onClose}>
      <div className="stack">
        <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); change({ topic }, 'Topic saved'); }}>
          <label className="field grow"><span>Topic</span><input maxLength={250} value={topic} disabled={!!channel.archived_at} onChange={(e) => setTopic(e.target.value)} placeholder="What it’s for" /></label>
          <button className="btn" disabled={!!channel.archived_at || topic === (channel.topic || '')}>Save topic</button>
        </form>
        {canManage && (
          <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); change({ name }, 'Channel renamed'); }}>
            <label className="field grow"><span>Name</span><input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button className="btn" disabled={!name.trim() || name === channel.name}>Rename</button>
          </form>
        )}
        {channel.private ? (
          <section className="stack" style={{ gap: 6 }}>
            <strong>Members{members ? ` (${members.length})` : ''}</strong>
            <ul className="member-list">
              {(members || []).map((m) => (
                <li key={m.id} className="row"><Avatar name={m.name} size={24} /><span className="grow">{m.name} <span className="muted small">{m.username}</span></span>
                  {m.id === me.id
                    ? <button type="button" className="btn small" onClick={() => setConfirm('leave')}>Leave</button>
                    : canManage && <button type="button" className="icon-btn" aria-label={`Take ${m.name} off`} onClick={async () => { await del(`/chat/channels/${channel.id}/members/${m.id}`); loadMembers(); onChanged(); }}><Icon name="close" size={16} /></button>}
                </li>
              ))}
            </ul>
            {!channel.archived_at && <>
              <PeoplePicker label="Add people" people={people.filter((p) => !memberIds.has(p.id) && !p.external)} chosen={adding} onChange={setAdding} />
              <div className="row"><button type="button" className="btn" disabled={!adding.size} onClick={async () => {
                try { await post(`/chat/channels/${channel.id}/members`, { user_ids: [...adding] }); setAdding(new Set()); loadMembers(); onChanged(); toast('Added'); } catch (e) { toast(e.message, 'error'); }
              }}>Add {adding.size || ''}</button></div>
            </>}
          </section>
        ) : <p className="muted small" style={{ margin: 0 }}>Everyone in the company can see and join this channel.</p>}
        {canManage && <WhoPosts channel={channel} people={people.filter((p) => !p.external)} onSave={(posters) => change({ posters }, posters ? 'Only the people chosen (and admins) can post now' : 'Everyone can post again')} />}
        {canManage && !general && (
          <div className="row wrap" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {!channel.private && <button type="button" className="btn" onClick={() => setConfirm('private')}>Make private</button>}
            {channel.private && <button type="button" className="btn" onClick={() => setConfirm('public')}>Open to everyone</button>}
            {channel.archived_at
              ? <button type="button" className="btn" onClick={() => change({ archived: false }, 'Channel unarchived')}>Unarchive</button>
              : <button type="button" className="btn danger" onClick={() => setConfirm('archive')}>Archive channel</button>}
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmModal danger={confirm === 'archive' || confirm === 'leave'}
          title={{ archive: 'Archive this channel?', private: 'Make this channel private?', public: 'Open this channel to everyone?', leave: 'Leave this channel?' }[confirm]}
          confirm={{ archive: 'Archive', private: 'Make private', public: 'Open to everyone', leave: 'Leave' }[confirm]}
          message={{ archive: 'It stays readable, under Show archived, but no one can write in it. You can unarchive it later.',
            private: 'Only you and the people who have written in it will see it; you can add others.',
            public: 'Everyone in the company will be able to see it and its messages.',
            leave: 'You won’t see it any more unless someone adds you again.' }[confirm]}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm === 'leave') { await del(`/chat/channels/${channel.id}/members/me`); onLeft(); return; }
            await change(confirm === 'archive' ? { archived: true } : { private: confirm === 'private' }, { archive: 'Channel archived', private: 'Channel is now private', public: 'Channel is open to everyone' }[confirm]);
            onClose();
          }} />
      )}
    </Modal>
  );
}

/** Text with the searched words marked. */
function Highlighted({ text, words }) {
  const list = String(words).toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) || [];
  if (!list.length) return text;
  const re = new RegExp(`(${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return String(text).slice(0, 300).split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

/** Record a voice message with the microphone: 🎙, then ■ to stop; it's added like an attached file. */
function VoiceRecorder({ onDone }) {
  const toast = useToast();
  const [rec, setRec] = useState(null); // { recorder, started }
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!rec) return undefined;
    const t = setInterval(() => setSecs(Math.floor((Date.now() - rec.started) / 1000)), 250);
    const max = setTimeout(() => rec.recorder.state === 'recording' && rec.recorder.stop(), 5 * 60e3); // five minutes at most
    return () => { clearInterval(t); clearTimeout(max); };
  }, [rec]);
  if (typeof window === 'undefined' || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return null;
  const start = async () => {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Allow the microphone to record a voice message', 'error'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    const started = Date.now();
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRec(null);
      const kind = (recorder.mimeType || type || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: kind });
      const s = Math.max(1, Math.round((Date.now() - started) / 1000));
      if (!blob.size || recorder.cancelled) return;
      const ext = kind === 'audio/mp4' ? 'm4a' : kind === 'audio/ogg' ? 'ogg' : 'weba';
      onDone(new File([blob], `Voice message ${Math.floor(s / 60)}.${String(s % 60).padStart(2, '0')}.${ext}`, { type: kind }));
    };
    recorder.start(250);
    setSecs(0);
    setRec({ recorder, started });
  };
  const stop = (cancel = false) => { if (rec) { rec.recorder.cancelled = cancel; rec.recorder.stop(); } };
  if (!rec) return <button type="button" className="icon-btn" aria-label="Record a voice message" title="Record a voice message" onClick={start}>🎙</button>;
  return (
    <span className="voice-rec" role="status" aria-label="Recording">
      <span className="rec-dot" aria-hidden="true" /> {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      <button type="button" className="icon-btn" aria-label="Stop recording" title="Stop and add it" onClick={() => stop(false)}>■</button>
      <button type="button" className="icon-btn" aria-label="Cancel recording" title="Throw it away" onClick={() => stop(true)}><Icon name="close" size={14} /></button>
    </span>
  );
}
