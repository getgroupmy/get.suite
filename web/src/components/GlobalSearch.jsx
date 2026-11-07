// The search box in the top bar. As you type it looks everywhere at once (files, chat, tasks, notes,
// events, contacts and colleagues) and lists the best few of each; Enter (with nothing picked) searches
// Drive in full, as before.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get } from '../api.js';
import Icon from './Icon.jsx';

const FILE_LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}`, folder: (f) => `/drive/folder/${f.id}` };
const FILE_ICON = { doc: 'doc', sheet: 'sheet', slides: 'slides', folder: 'folder' };
const PER_GROUP = 4;
const when = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

/** Everything that matches `text`, as groups of { key, icon, title, sub, to, state }. Each source failing on its own just leaves it out. */
export async function searchAll(text) {
  const qs = encodeURIComponent(text);
  const low = text.toLowerCase();
  const safe = (p) => p.catch(() => []);
  const [files, chat, tasks, notes, events, contacts, people] = await Promise.all([
    safe(get(`/files?view=search&q=${qs}`)), safe(get(`/chat/search?q=${qs}`)), safe(get(`/tasks/search?q=${qs}`)), safe(get(`/notes?q=${qs}`)),
    safe(get(`/events/search?q=${qs}`)), safe(get('/contacts')), safe(get('/users/directory')),
  ]);
  const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(low));
  return [
    ['Files', (Array.isArray(files) ? files : files.files || []).map((f) => ({ key: `f${f.id}`, icon: FILE_ICON[f.kind] || 'file', title: f.name,
      sub: f.owner_name ? `${f.owner_name} · ${when(f.updated_at)}` : when(f.updated_at), to: FILE_LINK[f.kind]?.(f) || `/drive/search?q=${encodeURIComponent(f.name)}` }))],
    ['Chat', chat.map((m) => ({ key: `c${m.id}`, icon: 'chat', title: m.body, sub: `${m.user_name || ''} · ${m.where} · ${when(m.created_at)}`,
      to: `/chat/${m.channel_id}?msg=${m.parent_id || m.id}${m.parent_id ? `&thread=${m.parent_id}` : ''}` }))],
    ['Tasks', tasks.map((t) => ({ key: `t${t.id}`, icon: 'check', title: `${t.done ? '✓ ' : ''}${t.title}`, sub: t.list_name, to: `/tasks/${t.list_id}?task=${t.id}` }))],
    ['Notes', notes.map((n) => ({ key: `n${n.id}`, icon: 'note', title: n.title || (n.body || (n.items || []).map((i) => i.text).join(', ')).slice(0, 80), sub: n.labels.join(', '), to: '/notes', state: { openNote: n.id } }))],
    ['Events', events.map((e) => ({ key: `e${e.id}:${e.start}`, icon: 'calendar', title: e.title, sub: `${when(e.start)}${e.location ? ` · ${e.location}` : ''}`, to: '/calendar', state: { openEvent: e } }))],
    ['Contacts', contacts.filter((c) => has(c.name, c.email, c.company, c.phone)).map((c) => ({ key: `k${c.id}`, icon: 'person', title: c.name || c.email, sub: [c.email, c.company].filter(Boolean).join(' · '), to: `/contacts?q=${encodeURIComponent(c.name || c.email)}` }))],
    ['People', people.filter((p) => has(p.name, p.username)).map((p) => ({ key: `p${p.id}`, icon: 'people', title: p.name, sub: p.username, to: `/contacts?q=${encodeURIComponent(p.name)}` }))],
  ].map(([name, list]) => [name, list.slice(0, PER_GROUP), list.length]).filter(([, list]) => list.length);
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
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
  const flat = (groups || []).flatMap(([, list]) => list);
  const go = (r) => { setOpen(false); setText(''); navigate(r.to, r.state ? { state: r.state } : undefined); };
  const submit = (e) => {
    e.preventDefault();
    if (pick >= 0 && flat[pick]) return go(flat[pick]);
    setOpen(false);
    navigate(`/drive/search?q=${encodeURIComponent(text.trim())}`); // empty: everything, to narrow with the filters
  };
  let i = -1;
  return (
    <form className="search global-search" role="search" onSubmit={submit} ref={box}>
      <Icon name="search" />
      <input name="q" placeholder="Search everything" aria-label="Search everything" autoComplete="off" value={text}
        role="combobox" aria-expanded={open && !!groups} aria-controls="search-results"
        onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(flat.length - 1, p + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(-1, p - 1)); }
          if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); }
        }} />
      {open && groups && (
        <div className="search-results" id="search-results" role="listbox" aria-label="Search results">
          {!groups.length && <p className="muted small search-none">Nothing found for “{text.trim()}”.</p>}
          {groups.map(([name, list, total]) => (
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
          <button type="submit" className="link-btn small search-all">Search Drive for “{text.trim()}” ↵</button>
        </div>
      )}
    </form>
  );
}
