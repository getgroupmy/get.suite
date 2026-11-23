import { emailPeopleWithAccess, meetPeopleWithAccess } from './emailpeople.js';
import MakeCopy from '../components/MakeCopy.jsx';
import MoveDialog from '../components/MoveDialog.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { viewOnly } from './drive/viewonly.js';
import { useNavigate } from 'react-router';
import { get, put, post, patch } from '../api.js';
import Icon from '../components/Icon.jsx';
import { Menu, Modal, useToast, useDataCheck } from '../components/ui.jsx';
import { ApprovalBanner, RequestApproval } from './drive/Approvals.jsx';
import { SignatureBanner, SendForSignature } from './docs/Signatures.jsx';
import { useAuth } from '../App.jsx';
import { createPortal } from 'react-dom';
import SendInChat from '../components/SendInChat.jsx';
import { useMailStatus } from '../mailStatus.js';
import { DRAFT_KEY } from './docs/blocks.js';
import { addToTasksWithToast } from './tasks/addtask.js';
import TasksAbout from '../components/TasksAbout.jsx';

/**
 * Debounced autosave with optimistic concurrency.
 * status: 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict'
 */
export function useAutosave(id, delay = 800) {
  const [status, setStatus] = useState('saved');
  const [conflict, setConflict] = useState(null);
  const r = useRef({ version: 0, dirty: false, timer: null, getContent: null, inflight: null, blocked: false });

  const api = useMemo(() => {
    const st = r.current;

    async function flush() {
      clearTimeout(st.timer);
      if (!st.dirty || st.blocked || !st.getContent) return;
      if (st.inflight) { await st.inflight; return flush(); }
      st.dirty = false;
      setStatus('saving');
      st.inflight = put(`/files/${id}/content`, { version: st.version, content: st.getContent() })
        .then(({ version }) => { st.version = version; setStatus(st.dirty ? 'unsaved' : 'saved'); })
        .catch((e) => {
          st.dirty = true;
          if (e.status === 409) { st.blocked = true; setConflict('Someone else'); setStatus('conflict'); }
          else { setStatus('error'); st.timer = setTimeout(flush, 5000); }
        })
        .finally(() => { st.inflight = null; });
      await st.inflight;
    }

    return {
      setVersion: (v) => { st.version = v; },
      changed(getContent) {
        st.getContent = getContent;
        st.dirty = true;
        if (st.blocked) return;
        setStatus('unsaved');
        clearTimeout(st.timer);
        st.timer = setTimeout(flush, delay);
      },
      isDirty: () => st.dirty || !!st.inflight,
      markConflict(name) { st.blocked = true; clearTimeout(st.timer); setConflict(name); setStatus('conflict'); },
      resolve() { st.blocked = false; st.dirty = false; setConflict(null); setStatus('saved'); },
      async forceSave(content) {
        const { file } = await get(`/files/${id}/content`);
        st.version = file.version;
        st.blocked = false;
        st.dirty = true;
        st.getContent = () => content;
        setConflict(null);
        await flush();
      },
      flush,
    };
  }, [id, delay]);

  // Save on leave; warn if the save can't happen.
  useEffect(() => {
    const st = r.current;
    const onBefore = (e) => { if (st.dirty || st.inflight) { api.flush(); e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onBefore);
    return () => { window.removeEventListener('beforeunload', onBefore); api.flush(); };
  }, [api]);

  return useMemo(() => ({ ...api, status, conflict }), [api, status, conflict]);
}

const STATUS = { saved: 'All changes saved', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Save failed, retrying…', conflict: 'Edit conflict', connecting: 'Connecting…', offline: 'Offline' };

export function EditorHeader({ icon, file, status, onRename, onShare, menu, extra }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  useEffect(() => { if (file) setName(file.name); }, [file]);
  const canEdit = file && (file.role === 'editor' || file.role === 'owner');
  // "Notify me of changes": a notification when someone else edits it (at most once an hour).
  const [watching, setWatching] = useState(false);
  useEffect(() => { if (file?.id) get(`/files/${file.id}/watch`).then((r) => setWatching(r.watching)).catch(() => {}); }, [file?.id]);
  const toggleWatch = async () => {
    try { const r = await put(`/files/${file.id}/watch`, { on: !watching }); setWatching(r.watching); toast(r.watching ? 'You’ll get a notification when someone else changes it' : 'No more notifications about changes'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const [requesting, setRequesting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [chatting, setChatting] = useState(false); // Send in Chat: its link in a conversation
  const [copying, setCopying] = useState(false); // Make a copy…: a name, and shared with the same people or not
  // Move to…: the same chooser as Drive's (find a folder, Recent, a new one); where it is now, after a move from here.
  const [moving, setMoving] = useState(false);
  const [parentNow, setParentNow] = useState(undefined);
  const moveBack = (from) => async () => {
    try { await patch(`/files/${file.id}`, { parent_id: from }); setParentNow(from); toast('Put back'); } catch (e) { toast(e.message, 'error'); }
  };
  const afterMove = async (moved, to) => {
    if (!moved?.length) return;
    setParentNow(to);
    const name = to ? await get(`/files/${to}`).then((f) => f.name).catch(() => 'the folder') : 'My Drive';
    toast(`Moved to ${name}`, 'info', { action: { label: 'Undo', onClick: moveBack(moved[0].parent_id) } });
  };
  const mail = useMailStatus();
  // Email: a new message in Mail with its link, or with it attached (Mail asks first: as Word, PDF…, or a link).
  const emailIt = (asFile) => {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const url = `${window.location.origin}${window.location.pathname}`;
    const draft = asFile ? { subject: file.name, convert: { id: file.id, name: file.name, size: file.size, mime: file.mime, kind: file.kind } }
      : { subject: file.name, html: `<p><a href="${esc(url)}">${esc(file.name)}</a></p>` };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { toast('Your browser’s storage is off', 'error'); return; }
    navigate('/mail?compose_doc=1');
  };
  // Send as email: a new message in Mail whose text is the document (its formatting, lists and pictures), its name the subject.
  const sendAsEmail = async () => {
    try {
      const { subject, html } = await get(`/files/${file.id}/email-body`);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ subject, html }));
      navigate('/mail?compose_doc=1');
    } catch (e) { toast(e instanceof DOMException ? 'Your browser’s storage is off' : e.message, 'error'); }
  };
  // Locked: nobody can change it (editors can lock; whoever locked it, or the owner, can unlock).
  const { user } = useAuth();
  const canUnlock = file?.locked_at && (file.locked_by === user?.id || file.role === 'owner');
  const setLocked = async (locked) => {
    try { await put(`/files/${file.id}/lock`, { locked }); window.location.reload(); } // open editors reload, read-only or editable again
    catch (e) { toast(e.message, 'error'); }
  };
  // "Viewers can't download, print or copy": those choices aren't offered, and printing shows a note instead.
  const takeOff = viewOnly(file);
  const offered = takeOff ? (menu || []).filter((it) => !(it && typeof it === 'object' && /^(Print|Download|Make a copy|Save as)/.test(it.label || ''))) : menu;
  const items = menu && file ? [...offered, ...(takeOff ? [] : [{ label: 'Make a copy…', icon: 'copy', onClick: () => setCopying(true) }]), ...(canEdit ? [{ label: 'Move to…', icon: 'move', onClick: () => setMoving(true) }] : []), '-', { label: `${watching ? '✓ ' : ''}Notify me of changes`, icon: 'bell', onClick: toggleWatch },
    { label: 'Send in Chat…', icon: 'send', onClick: () => setChatting(true) },
    { label: 'Chat with people who have access', icon: 'chat', onClick: async () => {
      try { const r = await post(`/files/${file.id}/chat`, {}); toast(r.created ? 'A channel for it, with everyone it’s shared with' : r.added ? `Added ${r.added} more to its channel` : 'Its channel'); navigate(`/chat/${r.id}`); } catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Add to Tasks', icon: 'check', onClick: () => addToTasksWithToast(toast, navigate, { title: file.name, link: { url: window.location.pathname, label: `File: ${file.name}` } }).then(() => setTaskBump((n) => n + 1)) },
    ...(mail?.enabled && canEdit ? [{ label: 'Email people with access', icon: 'mail', onClick: () => emailPeopleWithAccess(file, { navigate, toast }) }] : []),
    ...(canEdit ? [{ label: 'Schedule a meeting with people with access', icon: 'calendar', onClick: () => meetPeopleWithAccess(file, { navigate, toast }) }] : []),
    ...(mail?.enabled ? [{ label: 'Email link', icon: 'mail', onClick: () => emailIt(false) }, ...(takeOff ? [] : [{ label: 'Email as attachment…', icon: 'mail', onClick: () => emailIt(true) }])] : []),
    ...(mail?.enabled && (icon === 'doc' || icon === 'slides') && !takeOff ? [{ label: 'Send as email', icon: 'mail', onClick: sendAsEmail }] : []),
    ...(canEdit ? [{ label: 'Request approval…', icon: 'check', onClick: () => setRequesting(true) }] : []),
    ...(file.role === 'owner' ? [{ label: 'Publish to the web…', icon: 'link', onClick: () => setPublishing(true) }] : []),
    ...(canEdit && icon === 'doc' && !file.locked_at ? [{ label: 'Send for signature…', icon: 'edit', onClick: () => setSigning(true) }] : []),
    ...(canEdit && !file.locked_at ? [{ label: 'Lock (stop changes)', icon: 'lock', onClick: () => setLocked(true) }] : []),
    ...(canUnlock ? [{ label: 'Unlock', icon: 'lock', onClick: () => setLocked(false) }] : [])] : menu;

  const [taskBump, setTaskBump] = useState(0); // (Add to Tasks made one: count again)
  async function commit() {
    const n = name.trim();
    if (!n || n === file.name) return setName(file.name);
    try { await onRename(n); } catch (e) { toast(e.message, 'error'); setName(file.name); }
  }

  return (<>
    <header className="editor-head">
      <button className="icon-btn" aria-label="Back to Drive" onClick={() => navigate(file?.parent_id ? `/drive/folder/${file.parent_id}` : '/drive')}>
        <Icon name="back" />
      </button>
      <Icon name={icon} size={28} className={`ft ft-${icon}`} />
      <div className="editor-title">
        <input value={name} aria-label="File name" disabled={!canEdit} onChange={(e) => setName(e.target.value)}
          onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(file.name); e.currentTarget.blur(); } }} />
        <span className={`save-status ${status}`}>{file ? STATUS[status] : ''}</span>
      </div>
      <div className="grow" />
      {file?.id && <TasksAbout url={window.location.pathname} bump={taskBump} />}
      {extra}
      {items && <Menu trigger={(p) => <button className="icon-btn" aria-label="More" {...p}><Icon name="more" /></button>} items={items} />}
      {file?.role === 'owner' && <button className="btn primary" onClick={onShare}><Icon name="share" size={18} /> Share</button>}
    </header>
    {publishing && file && <PublishDialog file={file} onClose={() => setPublishing(false)} />}
    {copying && file && createPortal(<MakeCopy file={file} onClose={() => setCopying(false)} />, document.body)}
    {moving && file && createPortal(<MoveDialog files={[{ ...file, parent_id: parentNow === undefined ? file.parent_id ?? null : parentNow }]} onClose={() => setMoving(false)} onMoved={afterMove} />, document.body)}
    {chatting && file && createPortal(<SendInChat items={[{ name: file.name, url: `${window.location.origin}${window.location.pathname}` }]} what={icon === 'sheet' ? 'the spreadsheet' : icon === 'slides' ? 'the presentation' : 'the document'} onClose={() => setChatting(false)} />, document.body)}
    {takeOff && <style>{'@media print { body * { visibility: hidden !important; } body::before { content: "Printing is turned off for this file."; visibility: visible; display: block; padding: 40px; font: 16px sans-serif; } } .paper .tiptap, .grid td, .slide-stage { user-select: none; }'}</style>}
    {takeOff && <div className="banner small" role="note">View only: the owner has turned off downloading, printing and copying.</div>}
    {file?.locked_at && (
      <div className="banner lock-banner row wrap" role="region" aria-label="Locked">
        <Icon name="lock" size={18} />
        <span className="grow"><strong>Locked</strong> by {file.locked_by === user?.id ? 'you' : file.locked_by_name} · nobody can change it until it's unlocked</span>
        {canUnlock && <button type="button" className="btn small" onClick={() => setLocked(false)}>Unlock</button>}
      </div>
    )}
    {file?.id && file.role !== 'owner' && <SharedNote file={file} />}
    {file?.id && <ApprovalBanner fileId={file.id} />}
    {requesting && <RequestApproval file={file} onClose={() => setRequesting(false)} />}
    {file?.id && icon === 'doc' && <SignatureBanner fileId={file.id} me={user} onChanged={() => window.location.reload()} />}
    {signing && <SendForSignature file={file} onClose={(sent) => { setSigning(false); if (sent) window.location.reload(); }} />}
  </>);
}

/** Publish to the web: a read-only page anyone with its address can see, always the latest version. */
function PublishDialog({ file, onClose }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  useEffect(() => { get(`/publish/${file.id}`).then(setState).catch((e) => toast(e.message, 'error')); }, [file.id, toast]);
  const url = state?.published ? `${window.location.origin}${state.path}` : '';
  const [dataCheck, checkData] = useDataCheck();
  const turn = async (on) => { try { const r = await checkData((more) => put(`/publish/${file.id}`, { on, ...more })); if (!r) return; setState(r); toast(on ? 'Published' : 'No longer published'); } catch (e) { toast(e.message, 'error'); } };
  const what = { doc: 'document', sheet: 'spreadsheet', slides: 'presentation' }[file.kind] || 'file';
  return (
    <Modal title="Publish to the web" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {dataCheck}
      {!state ? <p className="muted">Loading…</p> : state.published ? (
        <div className="stack">
          <p style={{ margin: 0 }}>This {what} is published. Anyone with the address can read it (no account needed), and it always shows the latest version. Comments, speaker notes and suggestions aren't shown.</p>
          <div className="row"><input className="grow" readOnly value={url} aria-label="Published address" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(url); toast('Address copied'); } catch { toast(url); } }}>Copy</button>
            <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a></div>
          <EmbedCode url={url} />
          <p className="muted small" style={{ margin: 0 }}>Opened {state.views} time{state.views === 1 ? '' : 's'}.</p>
          <div><button type="button" className="btn danger" onClick={() => turn(false)}>Stop publishing</button></div>
        </div>
      ) : (
        <div className="stack">
          <p style={{ margin: 0 }}>Make a read-only page of this {what} that anyone with its address can see, without an account: for a price list, a policy, a timetable. It keeps showing the latest version until you stop publishing.</p>
          <div><button type="button" className="btn primary" onClick={() => turn(true)}>Publish</button></div>
        </div>
      )}
    </Modal>
  );
}

/** HTML to put a public page (a published file, a form) into another website, with Copy. */
/**
 * The banner over a file someone can only view or comment on (or that's locked), with **Request edit access**:
 * the owner gets the request among Drive's access requests, as for someone without access.
 */
export function ReadOnlyBanner({ file, commenter = 'You can comment, not edit.' }) {
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  const ask = async () => {
    try { await post(`/files/${file.id}/request-access`, { role: 'editor' }); setAsked(true); toast(`Asked ${file.owner_name || 'the owner'} for edit access`); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="banner">
      {file.locked_at ? 'Locked.' : file.role === 'commenter' ? commenter : 'View only.'}{' '}
      {!file.locked_at && (asked ? `Asked ${file.owner_name} for edit access.` : <>Ask {file.owner_name} for edit access. <button type="button" className="btn small" onClick={ask}>Request edit access</button></>)}
    </div>
  );
}

/** The message a file was shared with you with, at the top until you close it (remembered per file in this browser). */
function SharedNote({ file }) {
  const navigate = useNavigate();
  const key = `nw.sharedNote.${file.id}`;
  const [note, setNote] = useState(null);
  useEffect(() => {
    let off = false;
    try { if (localStorage.getItem(key)) return undefined; } catch { /* storage off: show it */ }
    get(`/files/${file.id}`).then((f) => { if (!off && f.shared_note) setNote({ by: f.shared_by_name, byId: f.shared_by, text: f.shared_note }); }).catch(() => {});
    return () => { off = true; };
  }, [file.id, key]);
  if (!note) return null;
  return (
    <div className="banner shared-note" role="note">
      <span className="grow">{note.by || 'Someone'} shared it with you: “{note.text}”</span>
      {note.byId && <button type="button" className="btn small" onClick={async () => {
        try {
          const { id } = await post('/chat/dm', { user_id: note.byId });
          // The file's link in the message box (after anything already drafted there), as Send in Chat does.
          const drafts = await get('/chat/drafts').catch(() => ({}));
          const before = drafts[id]?.body?.trim();
          const link = `${window.location.origin}${window.location.pathname}`;
          if (!before?.includes(link)) await put(`/chat/channels/${id}/draft`, { body: before ? `${before}\n${link}` : link, client: 'send-in-chat' }).catch(() => {});
          navigate(`/chat/${id}`);
        } catch { /* not reachable: stay */ }
      }}>Reply in Chat</button>}
      <button type="button" className="icon-btn" aria-label="Close the message" onClick={() => { setNote(null); try { localStorage.setItem(key, '1'); } catch { /* fine */ } }}><Icon name="close" size={16} /></button>
    </div>
  );
}

export function EmbedCode({ url, height = 600 }) {
  const toast = useToast();
  const code = `<iframe src="${url}?embed=1" width="100%" height="${height}" style="border:0" loading="lazy"></iframe>`;
  return (
    <details className="embed-code">
      <summary className="small">Embed in a website</summary>
      <div className="row"><textarea className="grow" readOnly rows={2} value={code} aria-label="Embed code" onFocus={(e) => e.target.select()} />
        <button type="button" className="btn small" onClick={async () => { try { await navigator.clipboard.writeText(code); toast('Embed code copied'); } catch { toast(code); } }}>Copy</button></div>
    </details>
  );
}
