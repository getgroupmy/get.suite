import { useEffect, useMemo, useRef, useState } from 'react';
import { viewOnly } from './drive/Drive.jsx';
import { useNavigate } from 'react-router';
import { get, put } from '../api.js';
import Icon from '../components/Icon.jsx';
import { Menu, useToast } from '../components/ui.jsx';
import { ApprovalBanner, RequestApproval } from './drive/Approvals.jsx';
import { SignatureBanner, SendForSignature } from './docs/Signatures.jsx';
import { useAuth } from '../App.jsx';

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
  const items = menu && file ? [...offered, '-', { label: `${watching ? '✓ ' : ''}Notify me of changes`, icon: 'bell', onClick: toggleWatch },
    ...(canEdit ? [{ label: 'Request approval…', icon: 'check', onClick: () => setRequesting(true) }] : []),
    ...(canEdit && icon === 'doc' && !file.locked_at ? [{ label: 'Send for signature…', icon: 'edit', onClick: () => setSigning(true) }] : []),
    ...(canEdit && !file.locked_at ? [{ label: 'Lock (stop changes)', icon: 'lock', onClick: () => setLocked(true) }] : []),
    ...(canUnlock ? [{ label: 'Unlock', icon: 'lock', onClick: () => setLocked(false) }] : [])] : menu;

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
      {extra}
      {items && <Menu trigger={(p) => <button className="icon-btn" aria-label="More" {...p}><Icon name="more" /></button>} items={items} />}
      {file?.role === 'owner' && <button className="btn primary" onClick={onShare}><Icon name="share" size={18} /> Share</button>}
    </header>
    {takeOff && <style>{'@media print { body * { visibility: hidden !important; } body::before { content: "Printing is turned off for this file."; visibility: visible; display: block; padding: 40px; font: 16px sans-serif; } } .paper .tiptap, .grid td, .slide-stage { user-select: none; }'}</style>}
    {takeOff && <div className="banner small" role="note">View only: the owner has turned off downloading, printing and copying.</div>}
    {file?.locked_at && (
      <div className="banner lock-banner row wrap" role="region" aria-label="Locked">
        <Icon name="lock" size={18} />
        <span className="grow"><strong>Locked</strong> by {file.locked_by === user?.id ? 'you' : file.locked_by_name} · nobody can change it until it's unlocked</span>
        {canUnlock && <button type="button" className="btn small" onClick={() => setLocked(false)}>Unlock</button>}
      </div>
    )}
    {file?.id && <ApprovalBanner fileId={file.id} />}
    {requesting && <RequestApproval file={file} onClose={() => setRequesting(false)} />}
    {file?.id && icon === 'doc' && <SignatureBanner fileId={file.id} me={user} onChanged={() => window.location.reload()} />}
    {signing && <SendForSignature file={file} onClose={(sent) => { setSigning(false); if (sent) window.location.reload(); }} />}
  </>);
}
