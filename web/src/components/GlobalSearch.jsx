// The search box in the top bar. As you type it looks everywhere at once (files, chat, tasks, notes,
// events, contacts and colleagues) and lists the best few of each; Enter (with nothing picked) searches
// Drive in full, as before.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, del } from '../api.js';
import Icon from './Icon.jsx';
import { useAuth } from '../App.jsx';
import { matchActions } from './searchactions.js';

const FILE_LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const FILE_ICON = { doc: 'doc', sheet: 'sheet', slides: 'slides', folder: 'folder' };
const PER_GROUP = 4;
const when = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

let mailOnce = null;
const mailEnabled = () => (mailOnce ??= get('/mail/status').then((st) => !!st.enabled).catch(() => false));

/** Everything that matches `text`, as groups of { key, icon, title, sub, to, state }. Each source failing on its own just leaves it out. */
export async function searchAll(text) {
  const qs = encodeURIComponent(text);
  const low = text.toLowerCase();
  const safe = (p) => p.catch(() => []);
  const mailOn = await mailEnabled();
  const mailIn = (folder) => (mailOn ? safe(get(`/mail/messages?folder=${encodeURIComponent(folder)}&q=${qs}`).then((r) => r.messages.map((m) => ({ ...m, folder })))) : Promise.resolve([]));
  const [files, chat, tasks, notes, events, contacts, people, inbox, sent, forms] = await Promise.all([
    safe(get(`/files?view=search&q=${qs}`)), safe(get(`/chat/search?q=${qs}`)), safe(get(`/tasks/search?q=${qs}`)), safe(get(`/notes?q=${qs}`)),
    safe(get(`/events/search?q=${qs}`)), safe(get('/contacts')), safe(get('/users/directory')), mailIn('INBOX'), mailIn('Sent'),
    safe(get(`/forms/search?q=${qs}`)),
  ]);
  const mail = [...inbox, ...sent].sort((a, b) => (b.date || 0) - (a.date || 0));
  const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(low));
  return [
    ['Files', (Array.isArray(files) ? files : files.files || []).map((f) => ({ key: `f${f.id}`, icon: FILE_ICON[f.kind] || 'file', title: f.name,
      sub: f.owner_name ? `${f.owner_name} · ${when(f.updated_at)}` : when(f.updated_at), to: FILE_LINK[f.kind]?.(f) || `/drive/search?q=${encodeURIComponent(f.name)}` }))],
    ['Mail', mail.map((m) => ({ key: `m${m.folder}${m.uid}`, icon: 'mail', title: m.subject || '(no subject)',
      sub: `${m.folder === 'Sent' ? `To ${(m.to || []).map((t) => t.name || t.address).join(', ')}` : (m.from?.name || m.from?.address || '')}${m.date ? ` · ${when(m.date)}` : ''}`,
      to: `/mail/${encodeURIComponent(m.folder)}/${m.uid}` }))],
    ['Chat', chat.map((m) => ({ key: `c${m.id}`, icon: 'chat', title: m.body, sub: `${m.user_name || ''} · ${m.where} · ${when(m.created_at)}`,
      to: `/chat/${m.channel_id}?msg=${m.parent_id || m.id}${m.parent_id ? `&thread=${m.parent_id}` : ''}` }))],
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
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [recent, setRecent] = useState(null); // your recent searches (loaded when the box is first opened)
  const [mailOn, setMailOn] = useState(false);
  useEffect(() => { mailEnabled().then(setMailOn); }, []);
  const actions = matchActions(text, { mail: mailOn, admin: !!user?.is_admin }).map((a) => ({ ...a, key: `a${a.key}`, action: true }));
  const showRecent = !text.trim() && recent?.length > 0;
  const remember = (q) => { if (q.trim().length >= 2) post('/users/me/recent-searches', { q: q.trim() }).then(setRecent).catch(() => {}); };
  const [groups, setGroups] = useState(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(-1);
  const box = useRef();
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
  const flat = [...recentHits, ...actions, ...(text.trim().length >= 2 ? (groups || []).flatMap(([, list]) => list) : [])];
  const go = async (r) => {
    if (r.recent) { setText(r.title); setPick(-1); return; } // search for it again
    setOpen(false);
    const typed = text;
    setText('');
    if (r.make) {
      try { const f = await post('/files/new', { kind: r.make }); navigate(`/${r.make === 'doc' ? 'docs' : r.make === 'sheet' ? 'sheets' : 'slides'}/${f.id}`); } catch { /* the app shows its own errors */ }
      return;
    }
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
      <input name="q" placeholder="Search everything" aria-label="Search everything" autoComplete="off" value={text}
        role="combobox" aria-expanded={open && !!groups} aria-controls="search-results"
        onFocus={() => { setOpen(true); if (recent === null) get('/users/me/recent-searches').then(setRecent).catch(() => setRecent([])); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); setPick(-1); }}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(flat.length - 1, p + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(-1, p - 1)); }
          if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); }
        }} />
      {open && (showRecent || actions.length > 0 || (groups && text.trim().length >= 2)) && (
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
          {actions.length > 0 && (
            <div className="search-group" role="group" aria-label="Actions">
              <div className="search-group-head muted small">Actions</div>
              {actions.map((r) => {
                i += 1;
                const me = i;
                return (
                  <button key={r.key} type="button" role="option" aria-selected={pick === me} className={`search-hit ${pick === me ? 'on' : ''}`} onMouseEnter={() => setPick(me)} onClick={() => go(r)}>
                    <Icon name={r.icon} size={18} /><span className="grow ellipsis"><span className="search-hit-title">{r.title}</span></span>
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
