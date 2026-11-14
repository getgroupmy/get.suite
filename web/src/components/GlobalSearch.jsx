// The search box in the top bar. As you type it looks everywhere at once (files, chat, tasks, notes,
// events, forms, chat conversations by name, contacts and colleagues) and lists the best few of each; Enter (with nothing picked) searches
// Drive in full, as before.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { notAShortcut } from './goto.js';
import { get, post, put, del } from '../api.js';
import Icon from './Icon.jsx';
import { useAuth } from '../App.jsx';
import { matchActions, detailedActions, wantsPeople, wantsChannels } from './searchactions.js';
import { localToday } from '../apps/tasks/taskmath.js';
import { addToTasksWithToast } from '../apps/tasks/addtask.js';
import { newEventMinutes, DEFAULT_CAL_PREFS } from '../apps/calendar/calprefs.js';
import { useToast } from './ui.jsx';

const FILE_LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const FILE_ICON = { doc: 'doc', sheet: 'sheet', slides: 'slides', folder: 'folder' };
const PER_GROUP = 4;
const when = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayOf = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
/** "Sat 14 Nov, 1:00 PM – 2:00 PM" or "Sat 14 Nov, all day" (and "· repeats"). */
const eventWhen = (e) => `${dayOf(e.start)}, ${e.all_day ? 'all day' : `${timeOf(e.start)} – ${timeOf(e.end)}`}${e.rrule ? ' · repeats' : ''}`;
/** "due Fri 20 Nov, 15:00 · repeats · high priority", or "no due date". */
const taskWhen = (t) => [t.due ? `due ${dayOf(new Date(`${t.due}T12:00`).getTime())}${t.due_time ? `, ${t.due_time}` : ''}` : 'no due date',
  t.repeat && 'repeats', t.priority && `${t.priority} priority`, t.important && 'important', ...(t.tags || []).map((x) => `#${x}`)].filter(Boolean).join(' · ');

const TIPS = [
  ['event Lunch tomorrow 1pm', 'a new event (add @name to invite, “in the Boardroom” for a room)', 'calendar'],
  ['task Send invoice friday !high', 'a task, added at once', 'check'],
  ['note ', 'a note (or “list milk, eggs” for a checklist)', 'note'],
  ['email @', 'a message to a colleague, the rest its subject', 'mail'],
  ['chat @', 'start a chat message to someone (or #channel)', 'chat'],
];

let mailOnce = null;
const mailEnabled = () => (mailOnce ??= get('/mail/status').then((st) => !!st.enabled).catch(() => false));

/** Everything that matches `text`, as groups of { key, icon, title, sub, to, state }. Each source failing on its own just leaves it out. */
export async function searchAll(text) {
  const qs = encodeURIComponent(text);
  const low = text.toLowerCase();
  const safe = (p) => p.catch(() => []);
  const mailOn = await mailEnabled();
  const mailIn = (folder) => (mailOn ? safe(get(`/mail/messages?folder=${encodeURIComponent(folder)}&q=${qs}`).then((r) => r.messages.map((m) => ({ ...m, folder })))) : Promise.resolve([]));
  const [files, chat, tasks, notes, events, contacts, people, inbox, sent, forms, convs, comments, meetChat] = await Promise.all([
    safe(get(`/files?view=search&q=${qs}`)), safe(get(`/chat/search?q=${qs}`)), safe(get(`/tasks/search?q=${qs}`)), safe(get(`/notes?q=${qs}`)),
    safe(get(`/events/search?q=${qs}`)), safe(get('/contacts')), safe(get('/users/directory')), mailIn('INBOX'), mailIn('Sent'),
    safe(get(`/forms/search?q=${qs}`)), safe(get(`/chat/conversations/search?q=${qs}`)), safe(get(`/comments/search?q=${qs}`)), safe(get(`/meet/chat/search?q=${qs}`)),
  ]);
  const mail = [...inbox, ...sent].sort((a, b) => (b.date || 0) - (a.date || 0));
  const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(low));
  return [
    ['Files', (Array.isArray(files) ? files : files.files || []).map((f) => ({ key: `f${f.id}`, icon: FILE_ICON[f.kind] || 'file', title: f.name,
      sub: f.owner_name ? `${f.owner_name} · ${when(f.updated_at)}` : when(f.updated_at), to: FILE_LINK[f.kind]?.(f) || `/drive/search?q=${encodeURIComponent(f.name)}` }))],
    ['Mail', mail.map((m) => ({ key: `m${m.folder}${m.uid}`, icon: 'mail', title: m.subject || '(no subject)',
      sub: `${m.folder === 'Sent' ? `To ${(m.to || []).map((t) => t.name || t.address).join(', ')}` : (m.from?.name || m.from?.address || '')}${m.date ? ` · ${when(m.date)}` : ''}`,
      to: `/mail/${encodeURIComponent(m.folder)}/${m.uid}` }))],
    ['Conversations', convs.map((c) => ({ key: `v${c.id}`, icon: c.dm ? 'person' : 'chat', title: c.dm ? c.name : `${c.private ? '🔒 ' : '#'}${c.name}`,
      sub: c.dm ? `Direct message${c.last_at ? ` · ${when(c.last_at)}` : ''}` : [c.archived ? 'Archived' : null, c.topic, c.private ? `${c.member_count} member${c.member_count === 1 ? '' : 's'}` : 'Channel'].filter(Boolean).join(' · '),
      to: `/chat/${c.id}` }))],
    ['Chat', chat.map((m) => ({ key: `c${m.id}`, icon: 'chat', title: m.body, sub: `${m.user_name || ''} · ${m.where} · ${when(m.created_at)}`,
      to: `/chat/${m.channel_id}?msg=${m.parent_id || m.id}${m.parent_id ? `&thread=${m.parent_id}` : ''}` }))],
    ['Meeting chats', meetChat.map((m) => ({ key: `g${m.id}`, icon: 'video', title: m.text, sub: `${m.name} · ${m.title || m.code}${m.room ? ` · room ${m.room}` : ''} · ${when(m.at)}`, to: `/meet?chat=${m.code}` }))],
    ['Comments', comments.map((c) => ({ key: `x${c.id}`, icon: 'chat', title: c.body, sub: `${c.author_name || 'Someone'} on “${c.file.name}”${c.resolved ? ' · resolved' : ''} · ${when(c.at)}`, to: c.link }))],
    ['Tasks', tasks.map((t) => ({ key: `t${t.id}`, icon: 'check', title: `${t.done ? '✓ ' : ''}${t.title}`, sub: t.list_name, to: `/tasks/${t.list_id}?task=${t.id}` }))],
    ['Notes', notes.map((n) => ({ key: `n${n.id}`, icon: 'note', title: n.title || (n.body || (n.items || []).map((i) => i.text).join(', ')).slice(0, 80), sub: n.labels.join(', '), to: '/notes', state: { openNote: n.id } }))],
    ['Events', events.map((e) => ({ key: `e${e.id}:${e.start}`, icon: 'calendar', title: e.title, sub: `${when(e.start)}${e.location ? ` · ${e.location}` : ''}`, to: '/calendar', state: { openEvent: e } }))],
    ['Forms', forms.map((f) => ({ key: `o${f.id}`, icon: 'form', title: f.title, sub: [`${f.responses} response${f.responses === 1 ? '' : 's'}`, f.closed ? 'not taking answers' : null, f.owner_name].filter(Boolean).join(' · '), to: `/forms/${f.id}` }))],
    ['Contacts', contacts.filter((c) => has(c.name, c.email, c.company, c.phone)).map((c) => ({ key: `k${c.id}`, icon: 'person', title: c.name || c.email, sub: [c.email, c.company].filter(Boolean).join(' · '), to: `/contacts?q=${encodeURIComponent(c.name || c.email)}` }))],
    ['People', people.filter((p) => has(p.name, p.username)).map((p) => ({ key: `p${p.id}`, icon: 'people', title: p.name, sub: p.username, to: `/contacts?q=${encodeURIComponent(p.name)}` }))],
  ].map(([name, list]) => [name, list.slice(0, PER_GROUP), list.length]).filter(([, list]) => list.length);
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [text, setText] = useState('');
  const [recent, setRecent] = useState(null); // your recent searches (loaded when the box is first opened)
  const [mailOn, setMailOn] = useState(false);
  useEffect(() => { mailEnabled().then(setMailOn); }, []);
  // "event …" offers that event, "email @kim …" that message (colleagues for @name, rooms for "in the Boardroom", loaded the first time it's typed).
  const [eventCtx, setEventCtx] = useState(null);
  const eventy = wantsPeople(text) || wantsChannels(text);
  useEffect(() => {
    if (!eventy || eventCtx) return;
    Promise.all([get('/users/directory').catch(() => []), get('/rooms').catch(() => []), get('/chat/channels').then((r) => r.channels || r).catch(() => [])])
      .then(([people, rooms, channels]) => setEventCtx({ people: people.filter((p) => p.id !== user?.id), rooms, channels }));
  }, [eventy, eventCtx, user?.id]);
  const detailed = detailedActions(text, { today: localToday(), minutes: newEventMinutes(user?.cal_prefs || DEFAULT_CAL_PREFS), mail: mailOn, ...(eventCtx || {}) })
    .map((a) => ({ ...a, key: `a${a.key}`, action: true, sub: a.quickChat ? (a.quickChat.text ? 'to finish and send in Chat' : '') : a.quickEvent ? eventWhen(a.quickEvent) : a.quickTask ? taskWhen(a.quickTask) : a.quickMail ? (a.quickMail.subject ? `“${a.quickMail.subject}”` : 'no subject yet') : a.quickNote?.labels.length ? a.quickNote.labels.map((l) => `#${l}`).join(' ') : '' }));
  const actions = [...detailed, ...(detailed.length ? [] : matchActions(text, { mail: mailOn, admin: !!user?.is_admin }))].map((a) => (a.action ? a : { ...a, key: `a${a.key}`, action: true }));
  const toast = useToast();
  const showRecent = !text.trim() && recent?.length > 0;
  const remember = (q) => { if (q.trim().length >= 2) post('/users/me/recent-searches', { q: q.trim() }).then(setRecent).catch(() => {}); };
  const [groups, setGroups] = useState(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(-1);
  const box = useRef();
  const input = useRef();
  // "/" anywhere (outside a text field, and not in Mail, where it searches mail) puts you in this box.
  const { pathname } = useLocation();
  useEffect(() => {
    if (user?.keys === false) return undefined; // Settings → Keyboard shortcuts: single keys off
    const onKey = (e) => {
      if (e.key !== '/' || notAShortcut(e) || /^\/mail(\/|$)/.test(pathname) || document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pathname, user?.keys]);
  const seq = useRef(0);
  useEffect(() => {
    const t = text.trim();
    if (t.length < 2) { setGroups(null); return undefined; }
    const n = ++seq.current;
    const timer = setTimeout(() => searchAll(t).then((g) => { if (n === seq.current) { setGroups(g); setPick(-1); } }), 250);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const recentHits = showRecent ? recent.map((q) => ({ key: `r${q}`, icon: 'clock', title: q, recent: true })) : [];
  // Tips (in the empty box): what can be typed to make things, each filling the box when picked. "Hide tips" for good.
  const showTips = !text.trim() && user?.search_tips !== false; // kept with your account (Settings → Search tips)
  const tipHits = showTips ? TIPS.map(([fill, what, icon]) => ({ key: `t${fill}`, icon, title: fill, sub: what, tip: true })) : [];
  const hideTips = () => put('/users/me/search-tips', { on: false }).then(() => { setUser({ ...user, search_tips: false }); toast('Tips hidden: Settings → Search tips brings them back'); }).catch((e) => toast(e.message, 'error'));
  const flat = [...recentHits, ...tipHits, ...actions, ...(text.trim().length >= 2 ? (groups || []).flatMap(([, list]) => list) : [])];
  const go = async (r) => {
    if (r.recent) { setText(r.title); setPick(-1); return; } // search for it again
    if (r.tip) { setText(r.title.replace(/…$/, '')); setPick(-1); input.current?.focus(); return; }
    setOpen(false);
    const typed = text;
    setText('');
    if (r.make) {
      try { const f = await post('/files/new', { kind: r.make }); navigate(`/${r.make === 'doc' ? 'docs' : r.make === 'sheet' ? 'sheets' : 'slides'}/${f.id}`); } catch { /* the app shows its own errors */ }
      return;
    }
    if (r.quickEvent) {
      const e = r.quickEvent;
      navigate('/calendar', { state: { newEvent: { title: e.title, start: e.start, end: e.end, all_day: e.all_day, location: '', description: '', ...(e.rrule && { rrule: e.rrule }),
        ...(e.guests.length && { guests: e.guests.map((email) => ({ email })) }), ...(e.rooms.length && { pick_rooms: e.rooms }) } } });
      return;
    }
    if (r.quickTask) { await addToTasksWithToast(toast, navigate, r.quickTask); return; }
    if (r.quickNote) {
      try { const n = await post('/notes', r.quickNote); toast(n.items ? 'Checklist added to Notes' : 'Note added', 'info', { action: { label: 'Open', onClick: () => navigate('/notes', { state: { openNote: n.id } }) } }); } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (r.quickChat) {
      // The conversation (a direct message is started if need be), with the words in its box as a draft, not sent.
      try {
        const c = r.quickChat;
        const id = c.channel ? c.channel.id : (await post('/chat/dm', { user_id: c.person.id })).id;
        if (c.text) {
          const had = (await get('/chat/drafts').catch(() => ({})))[id]?.body || '';
          await put(`/chat/channels/${id}/draft`, { body: had.trim() ? `${had}\n${c.text}` : c.text });
        }
        navigate(`/chat/${id}`);
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (r.quickMail) { navigate(`/mail?compose=${encodeURIComponent(r.quickMail.to.join(', '))}${r.quickMail.subject ? `&subject=${encodeURIComponent(r.quickMail.subject)}` : ''}`); return; }
    if (r.event) {
      const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
      navigate('/calendar', { state: { newEvent: { title: '', start: t.getTime(), end: t.getTime() + 36e5, all_day: 0, location: '', description: '' } } });
      return;
    }
    if (!r.action) remember(typed);
    navigate(r.to, r.state ? { state: r.state } : undefined);
  };
  const submit = (e) => {
    e.preventDefault();
    if (pick >= 0 && flat[pick]) return go(flat[pick]);
    remember(text);
    setOpen(false);
    navigate(`/drive/search?q=${encodeURIComponent(text.trim())}`); // empty: everything, to narrow with the filters
  };
  let i = -1;
  return (
    <form className="search global-search" role="search" onSubmit={submit} ref={box}>
      <Icon name="search" />
      <input ref={input} name="q" placeholder="Search everything" aria-label="Search everything" autoComplete="off" value={text}
        role="combobox" aria-expanded={open && !!groups} aria-controls="search-results"
        onFocus={() => { setOpen(true); if (recent === null) get('/users/me/recent-searches').then(setRecent).catch(() => setRecent([])); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); setPick(-1); }}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(flat.length - 1, p + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(-1, p - 1)); }
          if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); }
        }} />
      {open && (showRecent || showTips || actions.length > 0 || (groups && text.trim().length >= 2)) && (
        <div className="search-results" id="search-results" role="listbox" aria-label="Search results">
          {showRecent && (
            <div className="search-group" role="group" aria-label="Recent searches">
              <div className="search-group-head muted small row">Recent searches<span className="grow" />
                <button type="button" className="link-btn small" onClick={() => del('/users/me/recent-searches').then(setRecent).catch(() => {})}>Clear</button></div>
              {recentHits.map((r) => {
                i += 1;
                const me = i;
                return (
                  <div key={r.key} className="row search-recent">
                    <button type="button" role="option" aria-selected={pick === me} className={`search-hit grow ${pick === me ? 'on' : ''}`} onMouseEnter={() => setPick(me)} onClick={() => go(r)}>
                      <Icon name="clock" size={18} /><span className="grow ellipsis search-hit-title">{r.title}</span>
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Forget “${r.title}”`} onClick={() => del(`/users/me/recent-searches?q=${encodeURIComponent(r.title)}`).then(setRecent).catch(() => {})}><Icon name="close" size={14} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {showTips && (
            <div className="search-group" role="group" aria-label="Tips">
              <div className="search-group-head muted small row">Type to make things<span className="grow" />
                <button type="button" className="link-btn small" onClick={hideTips}>Hide tips</button></div>
              {tipHits.map((r) => {
                i += 1;
                const me = i;
                return (
                  <button key={r.key} type="button" role="option" aria-selected={pick === me} className={`search-hit ${pick === me ? 'on' : ''}`} onMouseEnter={() => setPick(me)} onClick={() => go(r)}>
                    <Icon name={r.icon} size={18} /><span className="grow ellipsis"><span className="search-hit-title">{r.title}</span><span className="muted small"> {r.sub}</span></span>
                  </button>
                );
              })}
            </div>
          )}
          {actions.length > 0 && (
            <div className="search-group" role="group" aria-label="Actions">
              <div className="search-group-head muted small">Actions</div>
              {actions.map((r) => {
                i += 1;
                const me = i;
                return (
                  <button key={r.key} type="button" role="option" aria-selected={pick === me} className={`search-hit ${pick === me ? 'on' : ''}`} onMouseEnter={() => setPick(me)} onClick={() => go(r)}>
                    <Icon name={r.icon} size={18} /><span className="grow ellipsis"><span className="search-hit-title">{r.title}</span>{r.sub && <span className="muted small"> {r.sub}</span>}</span>
                  </button>
                );
              })}
            </div>
          )}
          {text.trim().length >= 2 && groups && !groups.length && <p className="muted small search-none">Nothing found for “{text.trim()}”.</p>}
          {text.trim().length >= 2 && (groups || []).map(([name, list, total]) => (
            <div key={name} className="search-group" role="group" aria-label={name}>
              <div className="search-group-head muted small">{name}{total > list.length && ` · ${total}`}</div>
              {list.map((r) => {
                i += 1;
                const me = i;
                return (
                  <button key={r.key} type="button" role="option" aria-selected={pick === me} className={`search-hit ${pick === me ? 'on' : ''}`}
                    onMouseEnter={() => setPick(me)} onClick={() => go(r)}>
                    <Icon name={r.icon} size={18} />
                    <span className="grow ellipsis"><span className="search-hit-title">{r.title}</span>{r.sub && <span className="muted small"> {r.sub}</span>}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {text.trim().length >= 2 && <button type="submit" className="link-btn small search-all">Search Drive for “{text.trim()}” ↵</button>}
        </div>
      )}
    </form>
  );
}
