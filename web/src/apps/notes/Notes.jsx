// Notes: quick notes and checklists on coloured cards. "Take a note…" at the top, pinned ones first,
// labels and the archive on the left, and sharing with colleagues (they see changes as they happen).
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, put, del, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, Empty, Menu, Modal, PromptModal, ConfirmModal, useToast } from '../../components/ui.jsx';
import { quickTimes, reminderText } from './remind.js';

export const COLORS = [['', 'Default'], ['#faafa8', 'Coral'], ['#f39f76', 'Peach'], ['#fff8b8', 'Sand'], ['#e2f6d3', 'Mint'], ['#b4ddd3', 'Sage'],
  ['#d4e4ed', 'Fog'], ['#aeccdc', 'Storm'], ['#d3bfdb', 'Dusk'], ['#f6e2dd', 'Blossom'], ['#e9e3d4', 'Clay'], ['#efeff1', 'Chalk']];
const newItem = (text = '') => ({ id: Math.random().toString(36).slice(2, 10), text, done: false });

export default function Notes() {
  const toast = useToast();
  const [notes, setNotes] = useState(null);
  const [labels, setLabels] = useState([]);
  const [where, setWhere] = useState({ archived: false, label: null, reminders: false });
  const [picking, setPicking] = useState(null); // a note whose reminder time is being picked
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // note id
  const [sharing, setSharing] = useState(null);
  const [labelling, setLabelling] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ ...(where.archived && { archived: '1' }), ...(where.reminders && { reminders: '1' }), ...(where.label && { label: where.label }), ...(search.trim() && { q: search.trim() }) });
    get(`/notes?${qs}`).then(setNotes).catch((e) => toast(e.message, 'error'));
    get('/notes/labels').then(setLabels).catch(() => {});
  }, [where, search, toast]);
  useEffect(() => { const t = setTimeout(load, search ? 250 : 0); return () => clearTimeout(t); }, [load, search]);
  useEffect(() => onLive((m) => { if (m.type === 'notes-changed' || m.type === 'live-connected') load(); }), [load]);

  const change = async (n, changes) => {
    setNotes((list) => list.map((x) => (x.id === n.id ? { ...x, ...changes } : x)));
    try { await patch(`/notes/${n.id}`, changes); } catch (e) { toast(e.message, 'error'); }
    load();
  };
  const archive = async (n, on) => {
    await change(n, { archived: on });
    toast(on ? 'Note archived' : 'Note back from the archive', 'info', { action: { label: 'Undo', onClick: () => change(n, { archived: !on }) } });
  };
  const copy = async (n) => { try { await post(`/notes/${n.id}/copy`); toast('Copy made'); load(); } catch (e) { toast(e.message, 'error'); } };

  const pinned = (notes || []).filter((n) => n.pinned);
  const others = (notes || []).filter((n) => !n.pinned);
  const current = notes?.find((n) => n.id === editing);
  const card = (n) => <NoteCard key={n.id} note={n} onOpen={() => setEditing(n.id)} onChange={(c) => change(n, c)} onArchive={() => archive(n, !n.archived)}
    onLabel={() => setLabelling(n)} onShare={() => setSharing(n)} onCopy={() => copy(n)} onDelete={() => setDeleting(n)}
    onRemind={(t) => { if (t === 'pick') setPicking(n); else { change(n, { remind_at: t }); if (t) toast(`Reminder set for ${reminderText(t)}`); } }} />;
  return (
    <div className="notes-app">
      <aside className="subnav">
        <button type="button" className={`subnav-item ${!where.archived && !where.label && !where.reminders ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: false })}><Icon name="note" /><span className="grow">Notes</span></button>
        <button type="button" className={`subnav-item ${where.reminders ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: null, reminders: true })}><Icon name="bell" /><span className="grow">Reminders</span></button>
        {labels.map((l) => (
          <button key={l} type="button" className={`subnav-item ${where.label === l ? 'active' : ''}`} onClick={() => setWhere({ archived: false, label: l, reminders: false })}><span className="note-label-icon" aria-hidden="true">🏷</span><span className="grow ellipsis">{l}</span></button>
        ))}
        <button type="button" className={`subnav-item ${where.archived ? 'active' : ''}`} onClick={() => setWhere({ archived: true, label: null, reminders: false })}><Icon name="archive" /><span className="grow">Archive</span></button>
      </aside>
      <section className="notes-main">
        <div className="notes-search"><Icon name="search" size={18} /><input type="search" aria-label="Search notes" placeholder="Search notes" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {!where.archived && !where.reminders && <Composer label={where.label} onMade={load} />}
        {notes === null ? null : !notes.length ? (
          <Empty icon={where.archived ? 'archive' : 'note'} title={search ? 'No matching notes' : where.reminders ? 'No reminders set' : where.archived ? 'Nothing archived' : where.label ? `No notes labelled “${where.label}”` : 'Notes you add appear here'} />
        ) : <>
          {pinned.length > 0 && <><h2 className="notes-heading">Pinned</h2><div className="notes-grid" aria-label="Pinned notes">{pinned.map(card)}</div></>}
          {others.length > 0 && <>{pinned.length > 0 && <h2 className="notes-heading">Others</h2>}<div className="notes-grid" aria-label={where.archived ? 'Archived notes' : 'Notes'}>{others.map(card)}</div></>}
        </>}
      </section>
      {current && <NoteEditor key={current.id} note={current} onClose={() => { setEditing(null); load(); }} />}
      {sharing && <ShareNote note={sharing} onClose={() => { setSharing(null); load(); }} />}
      {labelling && <LabelNote note={labelling} all={labels} onSave={async (ls) => { await change(labelling, { labels: ls }); setLabelling(null); }} onClose={() => setLabelling(null)} />}
      {picking && <PickTime note={picking} onClose={() => setPicking(null)} onPick={(t) => { change(picking, { remind_at: t }); toast(`Reminder set for ${reminderText(t)}`); setPicking(null); }} />}
      {deleting && <ConfirmModal title={deleting.mine ? 'Delete this note?' : 'Remove this note?'} confirm={deleting.mine ? 'Delete' : 'Remove'}
        message={deleting.mine ? (deleting.shared.length ? 'It goes for everyone it’s shared with too.' : 'This can’t be undone.') : 'It stays for its owner and the others it’s shared with.'}
        onClose={() => setDeleting(null)} onConfirm={async () => { await del(`/notes/${deleting.id}`); setDeleting(null); load(); }} />}
    </div>
  );
}

/** "Take a note…": opens into a title and text (or a checklist) when clicked. */
function Composer({ label, onMade }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', body: '', items: null, color: '' });
  const box = useRef();
  const reset = () => { setF({ title: '', body: '', items: null, color: '' }); setOpen(false); };
  const save = async () => {
    const items = f.items?.filter((i) => i.text.trim());
    if (!f.title.trim() && !f.body.trim() && !items?.length) { reset(); return; }
    try { await post('/notes', { title: f.title, body: f.items ? '' : f.body, ...(f.items && { items }), color: f.color || null, labels: label ? [label] : [] }); reset(); onMade(); }
    catch (e) { toast(e.message, 'error'); }
  };
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest('.menu, .modal-backdrop')) save(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  });
  if (!open) {
    return (
      <div className="note-composer closed">
        <button type="button" className="grow note-take" onClick={() => setOpen(true)}>Take a note…</button>
        <button type="button" className="icon-btn" aria-label="New checklist" title="New checklist" onClick={() => { setF({ ...f, items: [newItem()] }); setOpen(true); }}><Icon name="check" /></button>
      </div>
    );
  }
  return (
    <div className="note-composer" ref={box} style={f.color ? { background: f.color, color: '#202124' } : undefined}>
      <input aria-label="Title" placeholder="Title" value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />
      {f.items ? <ChecklistEdit items={f.items} onChange={(items) => setF({ ...f, items })} autoFocus />
        : <textarea autoFocus aria-label="Take a note" placeholder="Take a note…" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}
      <div className="row note-tools">
        <ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} />
        <button type="button" className="icon-btn" aria-label={f.items ? 'Plain text' : 'Checklist'} title={f.items ? 'Plain text' : 'Checklist'}
          onClick={() => setF(f.items ? { ...f, body: f.items.map((i) => i.text).filter(Boolean).join('\n'), items: null } : { ...f, items: (f.body ? f.body.split('\n') : ['']).map((t) => newItem(t)), body: '' })}>{f.items ? '¶' : <Icon name="check" size={18} />}</button>
        <span className="grow" />
        <button type="button" className="btn small" onClick={save}>Close</button>
      </div>
    </div>
  );
}

function ChecklistEdit({ items, onChange, autoFocus }) {
  const refs = useRef({});
  const [focusId, setFocusId] = useState(null);
  useEffect(() => { if (focusId) { refs.current[focusId]?.focus(); setFocusId(null); } }, [focusId]);
  const set = (id, patch) => onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  return (
    <ul className="note-checklist editing">
      {items.map((it, k) => (
        <li key={it.id} className={`row ${it.done ? 'done' : ''}`}>
          <input type="checkbox" checked={it.done} aria-label={`Done: ${it.text || 'item'}`} onChange={(e) => set(it.id, { done: e.target.checked })} />
          <input ref={(el) => { refs.current[it.id] = el; }} className="grow" aria-label={`List item ${k + 1}`} value={it.text} maxLength={1000} autoFocus={autoFocus && k === items.length - 1}
            placeholder="List item" onChange={(e) => set(it.id, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const n = newItem(); onChange([...items.slice(0, k + 1), n, ...items.slice(k + 1)]); setFocusId(n.id); }
              if (e.key === 'Backspace' && !it.text && items.length > 1) { e.preventDefault(); onChange(items.filter((x) => x.id !== it.id)); setFocusId(items[k - 1]?.id || items[1]?.id); }
            }} />
          <button type="button" className="icon-btn" aria-label={`Remove item ${k + 1}`} onClick={() => onChange(items.filter((x) => x.id !== it.id))}><Icon name="close" size={14} /></button>
        </li>
      ))}
      <li><button type="button" className="link-btn small" onClick={() => { const n = newItem(); onChange([...items, n]); setFocusId(n.id); }}>+ List item</button></li>
    </ul>
  );
}

function ColorPicker({ value, onChange }) {
  return (
    <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Background colour" title="Background colour" {...p}>🎨</button>}
      items={COLORS.map(([c, name]) => ({ label: `${value === c || (!value && !c) ? '✓ ' : ''}${name}`, onClick: () => onChange(c) }))} />
  );
}

/** Pick a day and time for a reminder. */
function PickTime({ note, onPick, onClose }) {
  const pad = (x) => String(x).padStart(2, '0');
  const start = new Date(note.remind_at || quickTimes()[0][1]);
  const [v, setV] = useState(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`);
  const t = new Date(v).getTime();
  return (
    <Modal title="Remind me" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!(t > Date.now())} onClick={() => onPick(t)}>Save</button></>}>
      <label className="field"><span>Day and time</span><input type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} /></label>
      <p className="muted small">{note.shared.length ? 'Everyone the note is shared with gets the reminder too.' : 'You get a notification then.'}</p>
    </Modal>
  );
}

function NoteCard({ note: n, onOpen, onChange, onArchive, onLabel, onShare, onCopy, onDelete, onRemind }) {
  const items = n.items || [];
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const tick = (it) => onChange({ items: items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) });
  return (
    <article className="note-card" style={n.color ? { background: n.color, color: '#202124' } : undefined} aria-label={n.title || (n.body || items.map((i) => i.text).join(', ')).slice(0, 60) || 'Note'}>
      <button type="button" className={`icon-btn note-pin ${n.pinned ? 'on' : ''}`} aria-pressed={n.pinned} aria-label={n.pinned ? 'Unpin note' : 'Pin note'} onClick={() => onChange({ pinned: !n.pinned })}>📌</button>
      <div className="note-open" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
        {n.title && <h3>{n.title}</h3>}
        {n.body && <p className="note-body">{n.body.length > 800 ? `${n.body.slice(0, 800)}…` : n.body}</p>}
      </div>
      {items.length > 0 && (
        <ul className="note-checklist">
          {open.slice(0, 12).map((it) => <li key={it.id}><label className="check"><input type="checkbox" checked={false} onChange={() => tick(it)} /> <span>{it.text}</span></label></li>)}
          {open.length > 12 && <li className="muted small">+ {open.length - 12} more</li>}
          {done.length > 0 && <li className="muted small">{done.length} ticked {done.length === 1 ? 'item' : 'items'}</li>}
        </ul>
      )}
      {(n.labels.length > 0 || n.shared.length > 0 || !n.mine || n.remind_at) && (
        <div className="note-chips">
          {n.remind_at && <span className={`note-chip remind ${n.remind_at < Date.now() ? 'past' : ''}`}>⏰ {reminderText(n.remind_at)}<button type="button" className="chip-x" aria-label="Remove reminder" onClick={() => onRemind(null)}>×</button></span>}
          {n.labels.map((l) => <span key={l} className="note-chip">{l}</span>)}
          {!n.mine && <span title={`Shared by ${n.owner?.name}`}><Avatar name={n.owner?.name} size={22} userId={n.owner?.id} /></span>}
          {n.shared.filter((u) => n.mine || u.id !== n.owner?.id).slice(0, 4).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} size={22} userId={u.id} /></span>)}
        </div>
      )}
      <div className="row note-tools">
        <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Remind me" title="Remind me" {...p}><Icon name="bell" size={18} /></button>} items={[
          ...quickTimes().map(([label, t]) => ({ label: `${label} · ${reminderText(t)}`, onClick: () => onRemind(t) })),
          { label: 'Pick a day and time…', onClick: () => onRemind('pick') },
          ...(n.remind_at ? [{ label: 'Remove reminder', onClick: () => onRemind(null) }] : []),
        ]} />
        <ColorPicker value={n.color || ''} onChange={(color) => onChange({ color: color || null })} />
        <button type="button" className="icon-btn" aria-label={n.archived ? 'Unarchive' : 'Archive'} title={n.archived ? 'Unarchive' : 'Archive'} onClick={onArchive}><Icon name={n.archived ? 'restore' : 'archive'} size={18} /></button>
        {n.mine && <button type="button" className="icon-btn" aria-label="Share note" title="Share with colleagues" onClick={onShare}><Icon name="share" size={18} /></button>}
        <Menu trigger={(p) => <button type="button" className="icon-btn" aria-label="More" {...p}><Icon name="more" size={18} /></button>} items={[
          { label: 'Labels…', onClick: onLabel },
          { label: 'Make a copy', icon: 'copy', onClick: onCopy },
          { label: n.mine ? 'Delete note' : 'Remove from my notes', icon: 'trash', onClick: onDelete },
        ]} />
      </div>
    </article>
  );
}

/** A note open for editing: changes save when it closes (and every few seconds while typing). */
function NoteEditor({ note, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ title: note.title, body: note.body, items: note.items });
  const dirty = useRef(false);
  const saveRef = useRef(null);
  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    try { await patch(`/notes/${note.id}`, { title: f.title, ...(f.items ? { items: f.items } : { body: f.body, items: null }) }); } catch (e) { toast(e.message, 'error'); }
  }, [f, note.id, toast]);
  saveRef.current = save;
  useEffect(() => { const t = setTimeout(() => saveRef.current(), 1500); return () => clearTimeout(t); }, [f]);
  const edit = (patchF) => { dirty.current = true; setF({ ...f, ...patchF }); };
  const close = async () => { await save(); onClose(); };
  return (
    <Modal title={note.title || 'Note'} onClose={close} footer={<><span className="muted small grow">Edited {new Date(note.updated_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span><button type="button" className="btn" onClick={close}>Close</button></>}>
      <div className="stack note-editor" style={note.color ? { background: note.color, color: '#202124', padding: 12, borderRadius: 8 } : undefined}>
        <input aria-label="Title" placeholder="Title" value={f.title} maxLength={300} onChange={(e) => edit({ title: e.target.value })} />
        {f.items ? <ChecklistEdit items={f.items} onChange={(items) => edit({ items })} />
          : <textarea aria-label="Note" rows={8} value={f.body} onChange={(e) => edit({ body: e.target.value })} />}
        <div><button type="button" className="link-btn small" onClick={() => edit(f.items ? { items: null, body: f.items.map((i) => i.text).filter(Boolean).join('\n') } : { items: (f.body ? f.body.split('\n') : ['']).map((t) => newItem(t)), body: '' })}>
          {f.items ? 'Change to plain text' : 'Change to a checklist'}</button></div>
      </div>
    </Modal>
  );
}

function ShareNote({ note, onClose }) {
  const toast = useToast();
  const [people, setPeople] = useState([]);
  const [chosen, setChosen] = useState(new Set(note.shared.map((u) => u.id)));
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== note.owner?.id))).catch(() => {}); }, [note.owner?.id]);
  const save = async () => { try { await put(`/notes/${note.id}/shares`, { user_ids: [...chosen] }); toast('Sharing updated'); onClose(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title="Share note" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>People you share it with can change it and see changes as they're made. Only you can delete it.</p>
      <ul className="group-people" aria-label="Colleagues">
        {people.map((p) => <li key={p.id}><label className="check"><input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(p.id) : n.delete(p.id); setChosen(n); }} /> <Avatar name={p.name} size={22} userId={p.id} /> {p.name}</label></li>)}
      </ul>
    </Modal>
  );
}

function LabelNote({ note, all, onSave, onClose }) {
  const [chosen, setChosen] = useState(new Set(note.labels));
  const [adding, setAdding] = useState(false);
  const names = [...new Set([...all, ...chosen])].sort((a, b) => a.localeCompare(b));
  if (adding) return <PromptModal title="New label" label="Label" confirm="Add" onClose={() => setAdding(false)} onSubmit={async (name) => { setChosen(new Set([...chosen, name.trim().slice(0, 40)])); setAdding(false); }} />;
  return (
    <Modal title="Labels" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onSave([...chosen])}>Save</button></>}>
      <div className="stack-tight">
        {names.map((l) => <label key={l} className="check"><input type="checkbox" checked={chosen.has(l)} onChange={(e) => { const n = new Set(chosen); e.target.checked ? n.add(l) : n.delete(l); setChosen(n); }} /> {l}</label>)}
        <div><button type="button" className="link-btn" onClick={() => setAdding(true)}>+ New label</button></div>
      </div>
    </Modal>
  );
}
