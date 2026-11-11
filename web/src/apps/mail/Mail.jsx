import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeHistory } from '@tiptap/pm/history';
import { DRAFT_KEY } from '../docs/blocks.js';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, get, post, put, del, onLive, uploadFile, formatBytes, formatDate, setSharedMailbox, currentSharedMailbox, mailboxParam } from '../../api.js';
import { desktopSupported, desktopOn, enableDesktop, disableDesktop } from '../../mailNotify.js';
import Icon from '../../components/Icon.jsx';
import EmojiPicker from '../../components/EmojiPicker.jsx';
import AddressInput from '../../components/AddressInput.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, PromptModal, useToast, withDataCheck } from '../../components/ui.jsx';
import { whenText, laterChoices, ScheduleDialog } from '../../components/schedule.jsx';
import { useAuth } from '../../App.jsx';
import { useEditor, EditorContent, Node as TiptapNode, Extension, mergeAttributes } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor, FontSize, FontFamily } from '@tiptap/extension-text-style';
import { useMailStatus } from '../../mailStatus.js';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { mailKey, stepMessage, afterRemoval } from './mailkeys.js';
import { printMessage } from './mailprint.js';
import { previewKind, stepPreview } from '../../components/viewkind.js';
import FileViewer from '../../components/FileViewer.jsx';
import { textToHtml, docToText, emailHtml, isEmptyDoc, linkHref } from './richtext.js';
import { FiltersDialog } from './Filters.jsx';
import { ForwardingDialog } from './Forwarding.jsx';
import { MovePicker } from './MovePicker.jsx';
import DrivePicker from '../../components/DrivePicker.jsx';
import { parseAddresses } from '../../components/addresses.js';
import { fileLinksIn } from '../chat/filelinks.js';
import { addToTasksWithToast, mailLink } from '../tasks/addtask.js';
import { eventFromEmail } from '../calendar/fromemail.js';
import { ASPECTS, FULL, fitAspect, moveRect, resizeRect, toPixels, rotatedSize, outputType, editedName } from './cropmath.js';

const MAIL_DRAG = 'application/x-workspace-mail'; // messages being dragged: { folder, uids }
const FOLDER_ICON = { '\\Inbox': 'inbox', '\\Drafts': 'doc', '\\Sent': 'send', '\\Archive': 'archive', '\\Junk': 'report', '\\Trash': 'trash' };
const enc = encodeURIComponent;
const SNOOZED = 'Snoozed';
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const who = (a) => (a ? a.name || a.address : '');
const list = (arr) => (arr || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

// Your mail, or a shared mailbox you're a member of (support@…): the choice is kept for this tab, and
// Mail starts afresh on it (folders, messages and sending all go to that mailbox).
export default function MailPage() {
  const navigate = useNavigate();
  const [sharedList, setSharedList] = useState([]);
  const [mailbox, setMailbox] = useState(() => { try { return sessionStorage.getItem('nw-mailbox') || null; } catch { return null; } });
  useEffect(() => { get('/mail/status').then((s) => setSharedList(s.shared || [])).catch(() => {}); }, []);
  // How much is unread in each shared mailbox's Inbox (checked every minute while Mail is open).
  const [sharedUnread, setSharedUnread] = useState({});
  useEffect(() => {
    if (!sharedList.length) return undefined;
    const load = () => get('/mail/shared-unread').then((l) => setSharedUnread(Object.fromEntries(l.map((x) => [x.id, x.unseen])))).catch(() => {});
    load();
    const t = setInterval(load, 60e3);
    return () => clearInterval(t);
  }, [sharedList.length, mailbox]);
  const known = sharedList.find((b) => b.id === mailbox) || null;
  setSharedMailbox(known ? known.id : null); // before Mail's requests below
  useEffect(() => () => setSharedMailbox(null), []); // leaving Mail: back to your own
  const pick = (id) => {
    try { if (id) sessionStorage.setItem('nw-mailbox', id); else sessionStorage.removeItem('nw-mailbox'); } catch { /* private mode */ }
    setMailbox(id);
    navigate('/mail');
  };
  return <Mail key={known?.id || 'own'} shared={known} sharedList={sharedList.map((b) => ({ ...b, unseen: sharedUnread[b.id] || 0 }))} onPickMailbox={pick} />;
}

function Mail({ shared = null, sharedList = [], onPickMailbox }) {
  const toast = useToast();
  const navigate = useNavigate();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const folder = params.folder ? decodeURIComponent(params.folder) : 'INBOX';
  const openUid = params.uid ? Number(params.uid) : null;
  const q = search.get('q') || '';
  const labelId = search.get('label') || '';
  // ?open=<Message-ID> (from a task made from an email): find where the message is now and open it.
  const openId = search.get('open');
  useEffect(() => {
    if (!openId) return;
    get(`/mail/find?message_id=${enc(openId)}`).then((r) => navigate(`/mail/${enc(r.folder)}/${r.uid}`, { replace: true }))
      .catch((e) => { toast(e.message, 'error'); navigate('/mail', { replace: true }); });
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = Number(search.get('page') || 1);
  const [labels, setLabels] = useState([]);
  const [labelColors, setLabelColors] = useState([]);
  const [labelDialog, setLabelDialog] = useState(null); // {} new | label being changed
  const loadLabels = useCallback(() => get('/mail/labels').then((r) => { setLabels(r.labels); setLabelColors(r.colors); }).catch(() => {}), []);
  useEffect(() => { loadLabels(); }, [loadLabels]);

  const [folders, setFolders] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [vacation, setVacation] = useState(null);
  const [vacationOpen, setVacationOpen] = useState(false);
  const [forwarding, setForwarding] = useState(null);
  const [forwardingOpen, setForwardingOpen] = useState(false);
  const [filters, setFilters] = useState(null); // null | { startWith?: rule }
  const [newFolder, setNewFolder] = useState(false);
  const [folderDialog, setFolderDialog] = useState(null);
  const [signatures, setSignatures] = useState([]);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confOpen, setConfOpen] = useState(false); // your confidential messages
  const [subsOpen, setSubsOpen] = useState(false); // newsletters and lists in the Inbox
  const [storageOpen, setStorageOpen] = useState(false); // how much room mail takes
  const [emptying, setEmptying] = useState(null); // Trash or Junk, to empty now (asked first)
  const [scheduled, setScheduled] = useState([]);
  const refreshRef = useRef(null);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const loadScheduled = useCallback(() => get('/mail/scheduled').then(setScheduled).catch(() => {}), []);
  useEffect(() => { loadScheduled(); return onLive((m) => { if (m.type === 'mail-scheduled') { loadScheduled(); loadFolders(); } if (m.type === 'mail-snoozed' || m.type === 'mail-assigned' || m.type === 'mail-notes' || m.type === 'mail-tidied') refreshRef.current?.(); }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadScheduled]);
  const { user, setUser } = useAuth();
  // The list's width beside the reading pane: drag the line between them (or arrow keys on it); double-click for the usual.
  const [listWidth, setListWidth] = useState(user?.mail_list_width || null);
  const listRef = useRef(null);
  const saveListWidth = (width) => {
    setListWidth(width);
    put('/users/me/mail-list-width', { width }).then(() => setUser({ ...user, mail_list_width: width })).catch((e) => toast(e.message, 'error'));
  };
  const clampWidth = (w) => Math.max(260, Math.min(800, Math.round(w)));
  const dragDivider = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = listRef.current.getBoundingClientRect().left;
    let w = listWidth;
    const move = (ev) => { w = clampWidth(ev.clientX - left); setListWidth(w); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (w) saveListWidth(w); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => { get('/mail/signatures').then(setSignatures).catch(() => {}); }, []);
  // Opened with an email drafted in a document (/mail?compose_doc=1; the message waits in this browser's storage).
  useEffect(() => {
    if (search.get('compose_doc') === null) return;
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); localStorage.removeItem(DRAFT_KEY); } catch { /* storage off */ }
    // files: Drive files to attach (from Drive's "Email as attachment"); convert: a document to attach as Word, Excel… (asked first).
    if (d) setCompose(withSignature({ to: d.to || '', cc: d.cc || '', subject: d.subject || '', html: d.html || '', files: Array.isArray(d.files) ? d.files : [], convert: d.convert || null }, 'new'));
    const next = new URLSearchParams(search); next.delete('compose_doc'); setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.get('compose_doc')]);
  // Opened to write to someone (/mail?compose=addresses, e.g. from a contact group).
  useEffect(() => {
    const to = search.get('compose');
    if (to === null) return;
    setCompose(withSignature({ to }, 'new'));
    const next = new URLSearchParams(search); next.delete('compose'); setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.get('compose')]);

  /** Add the From address's signature to a new message, or above the quote in a reply/forward (never to resumed drafts). */
  // In a shared mailbox, its own signature (set by an admin; {name} is you) instead of yours.
  const sigs = shared ? (shared.signature ? [{ address: shared.address, html: textToHtml(shared.signature.replaceAll('{name}', user.name)), on_new: true, on_reply: true }] : []) : signatures;
  const withSignature = (init, kind) => {
    const from = shared ? shared.address : init.from || user.username;
    const block = signatureBlock(sigs, from, kind);
    const out = { ...init, from, kind };
    if (!block) return out;
    if (kind === 'new') return { ...out, html: `${init.html || '<p></p>'}${block}` };
    return { ...out, html: (init.html || '').replace(/^<p><\/p>/, `<p></p>${block}`) };
  };
  useEffect(() => { get('/mail/vacation').then(setVacation).catch(() => {}); }, []);
  useEffect(() => { get('/mail/forwarding').then(setForwarding).catch(() => {}); }, []);

  const loadFolders = useCallback(() => get('/mail/folders').then(setFolders).catch((e) => setError(e.message)), []);
  // Saved searches in the sidebar, with how many unread match (refreshed with the folders).
  const [searches, setSearches] = useState([]);
  const loadSearches = useCallback(() => { if (!shared) get('/mail/searches').then(setSearches).catch(() => {}); }, [shared]);
  useEffect(() => { loadSearches(); }, [loadSearches]);
  // Inbox tabs: Primary (people) and Updates (newsletters, notifications), unless turned off in Filters.
  const [tabsOn, setTabsOn] = useState(false);
  const [tab, setTab] = useState('primary');
  useEffect(() => { if (!shared) get('/mail/inbox-tabs').then((r) => setTabsOn(r.on)).catch(() => {}); }, [shared]);
  useEffect(() => { const on = () => get('/mail/inbox-tabs').then((r) => setTabsOn(r.on)).catch(() => {}); window.addEventListener('nw:inbox-tabs', on); return () => window.removeEventListener('nw:inbox-tabs', on); }, []);
  const tabbed = tabsOn && !shared && folder === 'INBOX' && !q && !labelId;
  const loadList = useCallback(() => get(`/mail/messages?folder=${enc(folder)}&page=${page}${q ? `&q=${enc(q)}` : ''}${labelId ? `&label=${enc(labelId)}` : ''}${tabbed ? `&tab=${tab}` : ''}`)
    .then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [folder, page, q, labelId, tabbed, tab]);

  useEffect(() => { setData(null); setChecked(new Set()); loadList(); }, [loadList]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  // New mail arrives: refresh straight away instead of waiting for the next 30-second check.
  useEffect(() => onLive((m) => {
    if (m.type === 'mail-new' || m.type === 'mail-unread') { loadFolders(); loadSearches(); if (m.type === 'mail-unread' || m.folder === folder) loadList(); }
  }), [loadFolders, loadList, loadSearches, folder]);
  // Folders with new-mail notifications (Inbox always). The badge counts unread mail across them.
  const [followed, setFollowed] = useState(['INBOX']);
  useEffect(() => { get('/mail/notify-folders').then((r) => setFollowed(r.folders)).catch(() => {}); }, []);
  useEffect(() => {
    if (!folders.length) return;
    const unseen = folders.filter((f) => followed.includes(f.path)).reduce((n, f) => n + (f.unseen || 0), 0);
    window.dispatchEvent(new CustomEvent('nw:unread', { detail: unseen }));
  }, [folders, followed]);
  async function toggleFollow(f) {
    const next = followed.includes(f.path) ? followed.filter((x) => x !== f.path) : [...followed, f.path];
    try {
      const r = await put('/mail/notify-folders', { folders: next });
      setFollowed(r.folders);
      toast(r.folders.includes(f.path) ? `You'll be notified about new mail in ${f.name}` : `No more notifications for ${f.name}`);
    } catch (e) { toast(e.message, 'error'); }
  }
  const [desktop, setDesktop] = useState(desktopOn());
  // Poll for new mail; retry quickly while the mailbox is unavailable (e.g. just created).
  const failing = !!error && !data;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) { loadFolders(); loadList(); } }, failing ? 4000 : 30000);
    return () => clearInterval(t);
  }, [loadFolders, loadList, failing]);

  const current = folders.find((f) => f.path === folder);
  const special = current?.specialUse;
  const refresh = () => { loadFolders(); loadList(); loadSearches(); };
  refreshRef.current = refresh;
  const [snoozing, setSnoozing] = useState(null); // uids waiting for a picked time
  const go = (f, uid) => {
    const keep = new URLSearchParams({ ...(q && { q }), ...(labelId && f === folder && { label: labelId }) }).toString();
    navigate(`/mail/${enc(f)}${uid ? `/${uid}` : ''}${keep ? `?${keep}` : ''}`);
  };

  // Keyboard shortcuts (see mailkeys.js); the open message's buttons do the work, so they behave the same.
  const keyState = useRef();
  const [picking, setPicking] = useState(null); // V / L: { kind: 'move' | 'label', uids }
  keyState.current = { data, openUid, special, folder, compose, go, checked, labels, shared, setPicking, openDraft: (uid) => openDraft(uid), newMessage: () => setCompose(withSignature({}, 'new')) };
  useEffect(() => {
    const onKey = (e) => {
      const action = mailKey(e);
      const st = keyState.current;
      if (!action || st.compose || document.querySelector('.modal-backdrop, [role=menu], [role=dialog]')) return;
      const reader = document.querySelector('.mail-reader');
      const button = (match) => [...(reader?.querySelectorAll('button') || [])].find(match);
      const byLabel = (...names) => button((b) => names.includes(b.getAttribute('aria-label')));
      const byText = (text) => button((b) => b.textContent.trim() === text);
      let target = null;
      switch (action) {
        case 'compose': e.preventDefault(); st.newMessage(); return;
        case 'search': e.preventDefault(); document.querySelector('.mail-search input')?.focus(); return;
        case 'next': case 'prev': {
          const uid = stepMessage(st.data?.messages, st.openUid, action);
          if (uid) { e.preventDefault(); if (st.special === '\\Drafts') st.openDraft(uid); else st.go(st.folder, uid); }
          return;
        }
        case 'list': if (st.openUid) { e.preventDefault(); st.go(st.folder); } return;
        case 'moveTo': case 'labelAs': { // the ticked messages, or the open one
          const uids = st.checked.size ? [...st.checked] : st.openUid ? [st.openUid] : [];
          if (!uids.length || st.special === '\\Drafts' || (action === 'labelAs' && (st.shared || !st.labels.length))) return;
          e.preventDefault(); st.setPicking({ kind: action === 'moveTo' ? 'move' : 'label', uids }); return;
        }
        case 'reply': target = byText('Reply'); break;
        case 'replyAll': target = byText('Reply all') || byText('Reply'); break;
        case 'forward': target = byText('Forward'); break;
        case 'archive': target = byLabel('Archive'); break;
        case 'delete': target = byLabel('Delete'); break;
        case 'star': target = byLabel('Star', 'Unstar'); break;
        case 'unread': target = byLabel('Mark unread'); break;
        default: return;
      }
      if (target && st.openUid) { e.preventDefault(); target.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dropping dragged messages on a folder (moves them) or a label (puts it on them).
  const [dropAt, setDropAt] = useState(null);
  const dropProps = (key, onDrop) => ({
    onDragOver: (e) => { if (!e.dataTransfer.types.includes(MAIL_DRAG)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropAt !== key) setDropAt(key); },
    onDragLeave: () => setDropAt((k) => (k === key ? null : k)),
    onDrop: (e) => {
      setDropAt(null);
      let d = null;
      try { d = JSON.parse(e.dataTransfer.getData(MAIL_DRAG)); } catch { return; }
      if (!d?.uids?.length || d.folder !== folder) return;
      e.preventDefault();
      onDrop(d);
    },
  });

  async function act(path, body, msg) {
    try {
      const from = folder;
      const r = await post(`/mail/messages/${path}`, { folder: from, ...body });
      // Moved somewhere (archived, binned, to Junk or a folder): Undo puts it back where it was.
      const undo = r?.moved?.uids?.length ? { label: 'Undo', onClick: async () => {
        try { await post('/mail/messages/move', { folder: r.moved.folder, uids: r.moved.uids, to: from }); toast(r.moved.uids.length === 1 ? 'Put back' : `Put back ${r.moved.uids.length} messages`); refresh(); }
        catch (e) { toast(e.message, 'error'); }
      } } : null;
      if (msg) toast(msg, 'info', undo ? { action: undo } : {});
      setChecked(new Set()); refresh(); return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  const [show, setShow] = useState('all'); // in a shared mailbox: all, given to me, not done
  if (failing) {
    return (
      <div className="page">
        <Empty icon="mail" title="Mail is unavailable">{error}</Empty>
        <div className="row" style={{ justifyContent: 'center' }}><button className="btn" onClick={() => { loadFolders(); loadList(); }}>Try again</button></div>
      </div>
    );
  }

  async function openDraft(uid) {
    try {
      const d = await get(`/mail/drafts/${uid}`);
      setCompose({ ...d, draftUid: d.uid, files: d.attachments });
    } catch (e) { toast(e.message, 'error'); }
  }

  const sel = [...checked];
  // A shared mailbox: show everything, what's given to you, or what isn't done yet (on this page).
  const shown = !data ? null : !shared || show === 'all' ? data.messages
    : data.messages.filter((m) => (show === 'mine' ? m.assignee?.id === user.id && !m.done : !m.done));
  return (
    <div className={`mail ${openUid ? 'reading' : ''} pane-${user?.mail_pane || 'right'}`}>
      <aside className="subnav">
        {sharedList.length > 0 && (
          <label className="field mailbox-pick"><span className="small muted">Mailbox</span>
            <select aria-label="Mailbox" value={shared?.id || ''} onChange={(e) => onPickMailbox(e.target.value || null)}>
              <option value="">Your mail</option>
              {sharedList.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.address}){b.unseen ? ` · ${b.unseen} unread` : ''}</option>)}
            </select>
          </label>
        )}
        {!shared && sharedList.some((b) => b.unseen) && <div className="small muted shared-unread" role="status">{sharedList.filter((b) => b.unseen).map((b) => `${b.name}: ${b.unseen} unread`).join(' · ')}</div>}
        {shared && (shared.delegated
          ? <div className="banner small" role="status"><strong>{shared.name}</strong>’s mail: what you send comes from {shared.address}, and says you sent it.</div>
          : <div className="banner small" role="status">Shared mailbox <strong>{shared.address}</strong>: replies go out from it.</div>)}
        <button className="btn new-btn" onClick={() => setCompose(withSignature({}, 'new'))}><Icon name="edit" /> Compose</button>
        {folders.map((f) => {
          const own = !f.specialUse && f.path.toUpperCase() !== 'INBOX';
          const followable = own || f.specialUse === '\\Archive'; // built-in Archive: notifications only, no rename/delete
          return (
            <div key={f.path} className="folder-row">
              <button className={`subnav-item ${f.path === folder && !q && !labelId ? 'active' : ''} ${dropAt === f.path ? 'drop-here' : ''}`} onClick={() => { setSearch({}); go(f.path); }}
                {...(f.path !== folder && f.specialUse !== '\\Drafts' && f.path !== SNOOZED ? dropProps(f.path, (d) => act('move', { uids: d.uids, to: f.path }, `${d.uids.length === 1 ? 'Moved' : `Moved ${d.uids.length} messages`} to ${f.name}`)) : {})}>
                <Icon name={FOLDER_ICON[f.specialUse] || (f.path === SNOOZED ? 'clock' : 'folder')} /><span className="grow ellipsis">{f.name}</span>
                {followable && followed.includes(f.path) && <Icon name="bell" size={14} className="followed" title="New-mail notifications on" />}
                {f.unseen > 0 && f.specialUse !== '\\Trash' && f.specialUse !== '\\Sent' && <span className="count">{f.unseen}</span>}
                {f.specialUse === '\\Drafts' && f.messages > 0 && <span className="count muted">{f.messages}</span>}
              </button>
              {followable && (
                <Menu align="left" trigger={(p) => <button className="icon-btn folder-menu" aria-label={`Options for ${f.name}`} {...p}><Icon name="more" size={18} /></button>} items={[
                  { label: followed.includes(f.path) ? 'Stop notifications' : 'Notify me about new mail', icon: 'bell', onClick: () => toggleFollow(f) },
                  ...(own ? [
                    { label: 'Rename', icon: 'edit', onClick: () => setFolderDialog({ type: 'rename', folder: f }) },
                    { label: 'Delete', icon: 'trash', danger: true, onClick: () => setFolderDialog({ type: 'delete', folder: f }) },
                  ] : []),
                ]} />
              )}
            </div>
          );
        })}
        {scheduled.length > 0 && (
          <button className="subnav-item" onClick={() => setScheduledOpen(true)}><Icon name="clock" /><span className="grow">Scheduled</span>
            <span className={`count ${scheduled.some((m) => m.status === 'failed') ? 'error' : 'muted'}`}>{scheduled.length}</span></button>
        )}
        <button className="subnav-item new-folder" onClick={() => setNewFolder(true)}><Icon name="plus" /><span className="grow">New folder</span></button>
        {!shared && searches.length > 0 && <>
          <div className="subnav-title">Searches</div>
          {searches.map((sv) => (
            <div key={sv.id} className="folder-row">
              <button className={`subnav-item ${folder === sv.folder && q === sv.query ? 'active' : ''}`} title={`${sv.query} (in ${folders.find((f) => f.path === sv.folder)?.name || sv.folder})`}
                onClick={() => navigate(`/mail/${enc(sv.folder)}?q=${enc(sv.query)}`)}>
                <Icon name="search" /><span className="grow ellipsis">{sv.name}</span>{sv.unseen > 0 && <span className="count">{sv.unseen}</span>}</button>
              <button type="button" className="icon-btn folder-menu" aria-label={`Remove saved search ${sv.name}`} title="Remove" onClick={async () => { await del(`/mail/searches/${sv.id}`); loadSearches(); }}><Icon name="close" size={16} /></button>
            </div>
          ))}
        </>}
        {!shared && <>
        <div className="subnav-title row">Labels<div className="grow" /><button type="button" className="icon-btn" aria-label="New label" onClick={() => setLabelDialog({})}><Icon name="plus" size={18} /></button></div>
        {labels.map((l) => (
          <div key={l.id} className="folder-row">
            <button className={`subnav-item ${labelId === l.id ? 'active' : ''} ${dropAt === `label:${l.id}` ? 'drop-here' : ''}`} onClick={() => setSearch({ label: l.id })}
              {...dropProps(`label:${l.id}`, (d) => act('labels', { uids: d.uids, add: [l.id] }, `Labelled ${l.name}`))}>
              <span className="label-dot" style={{ background: l.color }} /><span className="grow ellipsis">{l.name}</span>
            </button>
            <Menu align="left" trigger={(p) => <button className="icon-btn folder-menu" aria-label={`Options for label ${l.name}`} {...p}><Icon name="more" size={18} /></button>} items={[
              { label: 'Edit label', icon: 'edit', onClick: () => setLabelDialog(l) },
              { label: 'Delete label', icon: 'trash', danger: true, onClick: () => setLabelDialog({ ...l, deleting: true }) },
            ]} />
          </div>
        ))}
        <button className="subnav-item vacation-link" onClick={() => setVacationOpen(true)}>
          <Icon name="clock" /><span className="grow">Vacation reply</span>{vacation?.enabled && <span className="pill">{vacation.active ? 'On' : 'Scheduled'}</span>}
        </button>
        <button className="subnav-item" onClick={() => setFilters({})}><Icon name="settings" /><span className="grow">Filters</span></button>
        {!shared && <button className="subnav-item" onClick={() => setForwardingOpen(true)}><Icon name="forward" /><span className="grow">Forwarding</span>{forwarding?.enabled && !forwarding.blocked && <span className="pill">On</span>}</button>}
        <button className="subnav-item" onClick={() => setSignatureOpen(true)}><Icon name="edit" /><span className="grow">Signature</span></button>
        <button className="subnav-item" onClick={() => setImportOpen(true)}><Icon name="download" /><span className="grow">Import mail</span></button>
        {!shared && <button className="subnav-item" onClick={() => setConfOpen(true)}><Icon name="lock" /><span className="grow">Confidential messages</span></button>}
        {confOpen && <ConfidentialList onClose={() => setConfOpen(false)} />}
        {!shared && <button className="subnav-item" onClick={() => setSubsOpen(true)}><Icon name="markunread" /><span className="grow">Manage subscriptions</span></button>}
        {subsOpen && <Subscriptions onClose={() => { setSubsOpen(false); refresh(); }} />}
        {!shared && <button className="subnav-item" onClick={() => setStorageOpen(true)}><Icon name="chart" /><span className="grow">Storage</span></button>}
        {storageOpen && <MailStorage onClose={() => { setStorageOpen(false); refresh(); }} onOpen={(f, uid) => { setStorageOpen(false); go(f, uid); }} />}
        {desktopSupported() && (
          <button className="subnav-item" aria-pressed={desktop} onClick={async () => {
            if (desktop) { disableDesktop(); setDesktop(false); toast('Desktop notifications off'); return; }
            const ok = await enableDesktop();
            setDesktop(ok);
            toast(ok ? 'Desktop notifications on: you’ll be alerted to new mail while Workspace is open in a background tab' : 'Notifications are blocked in your browser settings for this site', ok ? 'info' : 'error');
          }}><Icon name="mail" /><span className="grow">Desktop alerts</span><span className={`pill ${desktop ? '' : 'off'}`}>{desktop ? 'On' : 'Off'}</span></button>
        )}
        </>}
      </aside>

      <section className="mail-list" ref={listRef} style={listWidth && (user?.mail_pane || 'right') === 'right' ? { width: listWidth } : undefined}>
        <div className="mail-toolbar">
          <form className="mail-search" role="search" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('q').trim(); setSearch(v ? { q: v } : {}); }}>
            <Icon name="search" size={18} />
            <input name="q" defaultValue={q} key={q} placeholder={`Search ${current?.name || 'mail'}`} aria-label="Search mail" title="Words, &quot;exact phrases&quot;, -leave out, from: to: subject: has:attachment is:unread is:read is:starred before:2026-01-31 after: newer_than:7d older_than:1y larger:5M smaller:" />
          </form>
          <button className="icon-btn" aria-label="Refresh" onClick={refresh}><Icon name="restore" size={20} /></button>
          {current?.unseen > 0 && <button className="icon-btn" aria-label="Mark all as read" title={`Mark all ${current.unseen} unread in ${current.name} as read`}
            onClick={async () => { try { const r = await post('/mail/messages/read-all', { folder }); toast(`${r.marked} marked as read`); refresh(); } catch (e) { toast(e.message, 'error'); } }}><Icon name="check" size={20} /></button>}
        </div>
        {!shared && vacation?.enabled && (vacation.active || vacation.scheduled) && (
          <div className="mail-vacation">
            <span>{vacation.active
              ? `Your vacation reply is on${vacation.end_date ? ` until ${fmtDay(vacation.end_date)}` : ''}.`
              : `Your vacation reply starts on ${fmtDay(vacation.start_date)}.`}</span>
            <button className="btn small" onClick={() => setVacationOpen(true)}>Edit</button>
            <button className="btn small" onClick={async () => {
              try { setVacation(await put('/mail/vacation', { ...vacation, enabled: false })); toast('Vacation reply turned off'); } catch (e) { toast(e.message, 'error'); }
            }}>Turn off</button>
          </div>
        )}
        {sel.length > 0 && (
          <div className="mail-bulk">
            <span>{sel.length} selected</span>
            <button className="btn small" onClick={() => act('flags', { uids: sel, seen: true })}>Mark read</button>
            <button className="btn small" onClick={() => act('flags', { uids: sel, seen: false })}>Mark unread</button>
            {special !== '\\Archive' && <button className="btn small" onClick={() => act('move', { uids: sel, to: 'archive' }, 'Archived')}>Archive</button>}
            {labels.length > 0 && (() => {
              const has = (id) => data?.messages.filter((m) => checked.has(m.uid)).every((m) => (m.labels || []).includes(id));
              return <Menu align="left" trigger={(p) => <button type="button" className="btn small" {...p}>Label</button>}
                items={labels.map((l) => ({ label: `${has(l.id) ? '✓ ' : ''}${l.name}`, onClick: () => act('labels', { uids: sel, [has(l.id) ? 'remove' : 'add']: [l.id] }, has(l.id) ? `Took off ${l.name}` : `Labelled ${l.name}`) }))} />;
            })()}
            {tabbed && <button className="btn small" title={tab === 'primary' ? 'Newsletters and notifications: keep them in Updates' : 'From people you want to read: keep them in Primary'}
              onClick={async () => { try { await Promise.all(sel.map((uid) => post(`/mail/messages/${uid}/tab`, { tab: tab === 'primary' ? 'updates' : 'primary' }))); toast(`Moved to ${tab === 'primary' ? 'Updates' : 'Primary'}`); setChecked(new Set()); refresh(); } catch (e) { toast(e.message, 'error'); } }}>
              Move to {tab === 'primary' ? 'Updates' : 'Primary'}</button>}
            <SnoozeMenu small onPick={(at) => act('snooze', { uids: sel, until: at }, `Snoozed until ${whenText(at)}`)} onCustom={() => setSnoozing(sel)} />
            {folder === SNOOZED && <button className="btn small" onClick={() => act('unsnooze', { uids: sel }, 'Back in the Inbox')}>Unsnooze</button>}
            <button className="btn small danger" onClick={() => act('delete', { uids: sel }, special === '\\Trash' ? 'Deleted forever' : 'Moved to Trash')}>Delete</button>
          </div>
        )}
        {labelId && <p className="muted small mail-note">Labelled <LabelChip label={labels.find((l) => l.id === labelId)} /> in {current?.name} · <button className="link" onClick={() => setSearch({})}>show all</button></p>}
        {q && <p className="muted small mail-note">Results for “{q}” in {current?.name} · <button className="link" onClick={() => setSearch({})}>clear</button>
          {!shared && !searches.some((sv) => sv.folder === folder && sv.query === q) && <> · <button className="link" onClick={async () => { try { await post('/mail/searches', { folder, query: q }); toast('Search saved: it\'s in the sidebar'); loadSearches(); } catch (e) { toast(e.message, 'error'); } }}>Save this search</button></>}</p>}
        {!shared && !q && (special === '\\Trash' || special === '\\Junk') && data?.messages?.length > 0 && (
          <p className="muted small mail-note">{special === '\\Trash' ? 'Mail in Trash' : 'Mail in Junk'} still takes room in your mailbox until it's deleted for good. <button type="button" className="link" onClick={() => setEmptying(current)}>Empty {current.name} now</button></p>
        )}
        {emptying && (
          <ConfirmModal title={`Empty ${emptying.name}?`} confirm={`Empty ${emptying.name}`} message={`Everything in ${emptying.name} is deleted for good. This can't be undone.`}
            onClose={() => setEmptying(null)} onConfirm={async () => {
              try { const r = await post('/mail/folders/empty', { folder: emptying.path }); toast(r.deleted ? `${r.deleted} message${r.deleted === 1 ? '' : 's'} deleted for good` : `${emptying.name} was already empty`); } catch (e) { toast(e.message, 'error'); }
              setEmptying(null); refresh();
            }} />
        )}
        {tabbed && (
          <div className="tabs mail-inbox-tabs" role="tablist" aria-label="Inbox tabs">
            {[['primary', 'Primary', 'person'], ['updates', 'Updates', 'bell']].map(([k, label, icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setChecked(new Set()); }}>
                <Icon name={icon} size={18} /> {label}
                {tab !== k && data?.tab === tab && data.otherUnread > 0 && <span className="count" aria-label={`${data.otherUnread} unread`}>{data.otherUnread}</span>}
              </button>
            ))}
          </div>
        )}
        {shared && data && (
          <div className="tabs mail-assign-tabs" role="tablist" aria-label="Show">
            {[['all', 'All'], ['mine', 'Given to me'], ['open', 'Not done']].map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{label}</button>)}
          </div>
        )}
        {!data ? <p className="muted mail-note">Loading…</p> : shown.length === 0 ? (
          <Empty icon={q ? 'search' : 'inbox'} title={q ? 'No messages found' : tabbed && tab === 'updates' ? 'No updates: newsletters and notifications go here' : `${current?.name || 'Folder'} is empty`} />
        ) : (
          <ul className={`msg-list ${user?.mail_list?.compact ? 'compact' : ''} ${user?.mail_list?.pictures ? 'pictures' : ''}`}>
            {shown.map((m) => (
              <li key={m.uid} className={`${m.seen ? '' : 'unread'} ${m.uid === openUid ? 'open' : ''}`} draggable={special !== '\\Drafts'}
                onDragStart={(e) => {
                  // Drag a message (or all the ticked ones, when it's one of them) onto a folder or a label.
                  const uids = checked.has(m.uid) ? [...checked] : [m.uid];
                  e.dataTransfer.setData(MAIL_DRAG, JSON.stringify({ folder, uids }));
                  e.dataTransfer.setData('text/plain', uids.length === 1 ? (m.subject || '(no subject)') : `${uids.length} messages`);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDropAt(null)}>
                <input type="checkbox" aria-label={`Select ${m.subject || '(no subject)'}`} checked={checked.has(m.uid)}
                  onChange={(e) => { const n = new Set(checked); e.target.checked ? n.add(m.uid) : n.delete(m.uid); setChecked(n); }} />
                {user?.mail_list?.pictures && (() => {
                  // The sender (or, in Sent and Drafts, the first person it's to): a colleague's photo, else initials.
                  const p = special === '\\Sent' || special === '\\Drafts' ? m.to?.[0] : m.from;
                  return <span className="msg-pic"><Avatar name={p?.name || p?.address || '?'} email={p?.address} size={user.mail_list.compact ? 24 : 32} /></span>;
                })()}
                <button className="msg-row" onClick={() => (special === '\\Drafts' ? openDraft(m.uid) : go(folder, m.uid))}>
                  <span className="msg-from ellipsis">{special === '\\Sent' || special === '\\Drafts' ? `To: ${m.to.map(who).join(', ')}` : who(m.from)}</span>
                  <span className="msg-date">{m.flagged && <span className="star" aria-label="Starred">★</span>}{m.attachment && <Icon name="attach" size={14} />} {m.snoozedUntil ? <span className="snoozed-until" title={`Comes back ${whenText(m.snoozedUntil)}`}><Icon name="clock" size={14} /> {formatDate(m.snoozedUntil)}</span> : m.date ? formatDate(m.date) : ''}</span>
                  <span className="msg-subject ellipsis">{(m.labels || []).map((id) => labels.find((l) => l.id === id)).filter(Boolean).map((l) => <LabelChip key={l.id} label={l} />)}{m.answered && '↩ '}{m.subject || '(no subject)'}</span>
                  {shared && (m.assignee || m.done) && <span className="msg-assign small">{m.done ? <span className="pill done">✓ Done</span> : null}{m.assignee && <span className="pill" title={`Given to ${m.assignee.name}`}>→ {m.assignee.id === user.id ? 'You' : m.assignee.name}</span>}</span>}
                  {shared && m.notes > 0 && <span className="msg-assign small"><span className="pill" title={`${m.notes} internal note${m.notes === 1 ? '' : 's'}`}>💬 {m.notes}</span></span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && data.total > (data.pageSize || 50) && (
          <div className="row mail-pager">
            <span className="muted small grow">{(page - 1) * 50 + 1}–{Math.min(page * 50, data.total)} of {data.total}</span>
            <button className="icon-btn" aria-label="Newer" disabled={page <= 1} onClick={() => setSearch({ ...(q && { q }), page: String(page - 1) })}><Icon name="left" /></button>
            <button className="icon-btn" aria-label="Older" disabled={page * 50 >= data.total} onClick={() => setSearch({ ...(q && { q }), page: String(page + 1) })}><Icon name="right" /></button>
          </div>
        )}
      </section>

      {(user?.mail_pane || 'right') === 'right' && (
        <div className="mail-divider" role="separator" aria-orientation="vertical" aria-label="Width of the message list" tabIndex={0}
          aria-valuemin={260} aria-valuemax={800} aria-valuenow={listWidth || Math.round(listRef.current?.getBoundingClientRect().width || 380)}
          title="Drag to make the list wider or narrower (double-click for the usual width)"
          onPointerDown={dragDivider} onDoubleClick={() => saveListWidth(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            saveListWidth(clampWidth((listWidth || listRef.current.getBoundingClientRect().width) + (e.key === 'ArrowRight' ? 20 : -20)));
          }} />
      )}
      <section className="mail-reader">
        {openUid ? (
          <Reader key={`${folder}:${openUid}`} shared={shared} folder={folder} uid={openUid} special={special} onSnoozeCustom={(uids) => setSnoozing(uids)} labels={labels} onNewLabel={() => setLabelDialog({})}
            onClose={() => go(folder)} onRemoved={() => go(folder, special === '\\Drafts' ? null : afterRemoval(shown, openUid, user?.mail_advance))} onOpen={(f, u) => go(f, u)} onChanged={refresh} act={act} onCompose={(init) => setCompose(withSignature(init, 'reply'))}
            onFilter={(from) => setFilters({ startWith: { name: `From ${from}`, enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: from }], actions: { stop: true } } })} />
        ) : <Empty icon="mail" title="No message selected" />}
      </section>

      {compose && <Compose initial={compose} shared={shared} signatures={sigs} onClose={() => setCompose(null)} onSent={() => { setCompose(null); refresh(); }} onDraftsChanged={refresh} />}
      {labelDialog && !labelDialog.deleting && <LabelDialog label={labelDialog} colors={labelColors} onClose={() => setLabelDialog(null)}
        onSaved={() => { setLabelDialog(null); loadLabels(); }} />}
      {labelDialog?.deleting && (
        <ConfirmModal title={`Delete label “${labelDialog.name}”?`} confirm="Delete label" message="It comes off every message that has it. The messages themselves stay."
          onClose={() => setLabelDialog(null)} onConfirm={async () => { await del(`/mail/labels/${labelDialog.id}`); if (labelId === labelDialog.id) setSearch({}); setLabelDialog(null); loadLabels(); refresh(); }} />
      )}
      {picking && <MovePicker title={picking.kind === 'move' ? (picking.uids.length === 1 ? 'Move to' : `Move ${picking.uids.length} messages to`) : 'Label as'}
        items={picking.kind === 'move'
          ? folders.filter((f) => f.path !== folder && f.specialUse !== '\\Drafts' && f.path !== SNOOZED).map((f) => ({ key: f.path, name: f.name }))
          : labels.map((l) => ({ key: l.id, name: l.name, dot: l.color }))}
        onClose={() => setPicking(null)}
        onPick={async (it) => {
          const { kind, uids } = picking;
          setPicking(null);
          const ok = kind === 'move'
            ? await act('move', { uids, to: it.key }, `${uids.length === 1 ? 'Moved' : `Moved ${uids.length} messages`} to ${it.name}`)
            : await act('labels', { uids, add: [it.key] }, `Labelled ${it.name}`);
          if (ok && kind === 'move' && uids.includes(openUid)) go(folder); // the open message has gone from here
        }} />}
      {snoozing && <ScheduleDialog title="Snooze until" confirm="Snooze" withinYear note={(at) => `It comes back to your Inbox ${whenText(at)}.`}
        onClose={() => setSnoozing(null)} onPick={async (at) => { const uids = snoozing; setSnoozing(null); if (await act('snooze', { uids, until: at }, `Snoozed until ${whenText(at)}`) && uids.includes(openUid)) go(folder); }} />}
      {scheduledOpen && <ScheduledDialog list={scheduled} onClose={() => setScheduledOpen(false)} onChanged={() => { loadScheduled(); refresh(); }} />}
      {filters && <FiltersDialog folders={folders} onFoldersChanged={loadFolders} startWith={filters.startWith} onClose={() => { setFilters(null); loadFolders(); }} />}
      {newFolder && <PromptModal title="New folder" label="Folder name (use / for subfolders, e.g. Clients/Acme)" confirm="Create" onClose={() => setNewFolder(false)}
        onSubmit={async (name) => { const r = await post('/mail/folders', { name }); toast(`Folder ${r.path} created`); loadFolders(); }} />}
      {importOpen && <ImportMail onClose={() => setImportOpen(false)} onDone={refresh} />}
      {signatureOpen && <SignatureDialog signatures={signatures} onClose={() => setSignatureOpen(false)} onSaved={(list) => setSignatures(list)} />}
      {folderDialog?.type === 'rename' && (
        <PromptModal title={`Rename “${folderDialog.folder.name}”`} label="New name (use / for subfolders)" initial={folderDialog.folder.path} confirm="Rename"
          onClose={() => setFolderDialog(null)}
          onSubmit={async (newPath) => {
            const r = await api('PATCH', '/mail/folders', { path: folderDialog.folder.path, newPath });
            get('/mail/notify-folders').then((x) => setFollowed(x.folders)).catch(() => {});
            toast(`Renamed to ${r.path}${r.updatedFilters ? ` · ${r.updatedFilters} filter${r.updatedFilters === 1 ? '' : 's'} updated` : ''}`);
            if (folder === folderDialog.folder.path || folder.startsWith(`${folderDialog.folder.path}/`)) go(r.path + folder.slice(folderDialog.folder.path.length));
            loadFolders();
          }} />
      )}
      {folderDialog?.type === 'delete' && (
        <ConfirmModal title={`Delete “${folderDialog.folder.name}”?`} confirm="Delete folder"
          message={`${folderDialog.folder.messages ? `Its ${folderDialog.folder.messages} message${folderDialog.folder.messages === 1 ? '' : 's'} will be moved to Trash. ` : ''}Subfolders are deleted too, and their messages also go to Trash. Filters that file mail here will be switched off.`}
          onClose={() => setFolderDialog(null)}
          onConfirm={async () => {
            const r = await api('DELETE', `/mail/folders?path=${enc(folderDialog.folder.path)}`);
            get('/mail/notify-folders').then((x) => setFollowed(x.folders)).catch(() => {});
            toast(['Folder deleted', r.movedToTrash && `${r.movedToTrash} message${r.movedToTrash === 1 ? '' : 's'} moved to Trash`,
              r.disabledFilters && `${r.disabledFilters} filter${r.disabledFilters === 1 ? '' : 's'} switched off`].filter(Boolean).join(' · '));
            if (folder === folderDialog.folder.path || folder.startsWith(`${folderDialog.folder.path}/`)) go('INBOX');
            loadFolders();
          }} />
      )}
      {forwardingOpen && <ForwardingDialog onClose={() => setForwardingOpen(false)} onChanged={setForwarding} />}
      {vacationOpen && <VacationDialog onClose={() => setVacationOpen(false)} onSaved={(v) => { setVacation(v); setVacationOpen(false); }} />}
    </div>
  );
}

/** On a message you sent with "remind me if no reply": when, and a way to cancel it. */
/** A calendar invitation (or cancellation) in the message: what, when, and Yes / Maybe / No. */
function InviteCard({ invite, uid, folder, onChange }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const when = invite.all_day
    ? new Date(invite.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${new Date(invite.start).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} – ${new Date(invite.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const answer = async (a) => {
    setBusy(true);
    try {
      const r = await post(`/mail/messages/${uid}/invite`, { folder, answer: a });
      onChange(r);
      toast(a === 'remove' ? 'Taken off your calendar' : a === 'no' ? `Declined${r.replied ? `; ${invite.organizer?.name || 'the organizer'} has been told` : ''}` : `${a === 'yes' ? 'Added' : 'Added as maybe'} to your calendar${r.replied ? `; ${invite.organizer?.name || 'the organizer'} has been told` : ''}`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const cancelled = invite.method === 'CANCEL';
  const open = () => navigate('/calendar', { state: { openEvent: { id: invite.event_id, start: invite.start, end: invite.end } } });
  if (invite.method === 'REPLY') {
    return (
      <section className="mail-invite-card" aria-label="Answer to your invitation">
        <div className="invite-date" aria-hidden="true"><span>{new Date(invite.start).toLocaleDateString([], { month: 'short' })}</span><strong>{new Date(invite.start).getDate()}</strong></div>
        <div className="grow stack" style={{ gap: 2 }}>
          <strong>{invite.who} {{ yes: 'accepted', maybe: 'said maybe to', no: 'declined' }[invite.answer]} “{invite.title}”</strong>
          <span className="small muted">Their answer is on your event.</span>
          <span className="row small"><button type="button" className="btn small" onClick={open}>See it in Calendar</button></span>
        </div>
      </section>
    );
  }
  return (
    <section className={`mail-invite-card ${cancelled ? 'cancelled' : ''}`} aria-label="Invitation">
      <div className="invite-date" aria-hidden="true"><span>{new Date(invite.start).toLocaleDateString([], { month: 'short' })}</span><strong>{new Date(invite.start).getDate()}</strong></div>
      <div className="grow stack" style={{ gap: 2 }}>
        <strong>{cancelled ? 'Cancelled: ' : ''}{invite.title}</strong>
        <span className="small">{when}{invite.repeats ? ' · repeats' : ''}</span>
        {invite.location && <span className="small muted">{invite.location}</span>}
        {invite.organizer && <span className="small muted">Organised by {invite.organizer.name || invite.organizer.email}</span>}
        {invite.internal ? (
          <span className="row small"><span className="muted">This invitation is in your calendar.</span>
            <button type="button" className="btn small" onClick={() => navigate("/calendar", { state: { openEvent: { id: invite.event_id, start: invite.start, end: invite.end } } })}>Answer in Calendar</button></span>
        ) : cancelled ? (
          <span className="row small">{invite.event_id ? <button type="button" className="btn small" disabled={busy} onClick={() => answer('remove')}>Remove from my calendar</button> : <span className="muted">It isn't on your calendar.</span>}</span>
        ) : (
          <span className="row small" role="group" aria-label="Going?">
            <span className="muted">Going?</span>
            {[['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']].map(([v, l]) => (
              <button key={v} type="button" className={`btn small ${invite.answer === v ? 'primary' : ''}`} aria-pressed={invite.answer === v} disabled={busy} onClick={() => answer(v)}>{l}</button>
            ))}
            {invite.event_id && <button type="button" className="link-btn small" onClick={() => navigate("/calendar", { state: { openEvent: { id: invite.event_id, start: invite.start, end: invite.end } } })}>See it in Calendar</button>}
          </span>
        )}
      </div>
    </section>
  );
}

function FollowUpBanner({ messageId }) {
  const toast = useToast();
  const [f, setF] = useState(null);
  useEffect(() => {
    setF(null);
    if (!messageId) return undefined;
    let alive = true;
    get(`/mail/followups?message_id=${encodeURIComponent(messageId)}`).then((l) => { if (alive) setF(l[0] || null); }).catch(() => {});
    return () => { alive = false; };
  }, [messageId]);
  if (!f) return null;
  return (
    <div className="banner" role="region" aria-label="Follow-up">
      <span className="grow">⏰ You'll be reminded {new Date(f.due_at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} if nobody has replied.</span>
      <button type="button" className="btn small" onClick={async () => { try { await del(`/mail/followups/${f.id}`); setF(null); toast('Follow-up reminder cancelled'); } catch (e) { toast(e.message, 'error'); } }}>Cancel reminder</button>
    </div>
  );
}

function Reader({ shared = null, folder, uid, special, onClose, onRemoved, onOpen, onChanged, act, onCompose, onFilter, onSnoozeCustom, labels = [], onNewLabel }) {
  const mailStatus = useMailStatus();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [m, setM] = useState(null);
  const [images, setImages] = useState(false);
  const [wholeQuote, setWholeQuote] = useState(false); // the quoted history under a reply, unfolded
  useEffect(() => { setWholeQuote(false); }, [uid]);
  const [blocking, setBlocking] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const [muted, setMuted] = useState(null); // its conversation is muted: the entry's id
  useEffect(() => {
    get(`/mail/messages/${uid}?folder=${enc(folder)}`).then((x) => {
      setM(x); onChanged();
      if (x.messageId) get(`/mail/muted/check?message_id=${encodeURIComponent(x.messageId)}&references=${encodeURIComponent((x.references || []).join(','))}`).then((r) => setMuted(r.id)).catch(() => {});
    }).catch((e) => { toast(e.message, 'error'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, uid]);
  const [viewing, setViewing] = useState(null); // the index of the attachment open in the viewer
  const [original, setOriginal] = useState(false); // Show original (before the early return below: hooks always in the same order)
  if (!m) return <p className="muted mail-note">Loading…</p>;

  // The original's body for a reply or forward. HTML mail keeps its basic formatting and embedded
  // pictures, cleaned by the server so hostile HTML never reaches the editor; plain-text mail (or if
  // that fails) is quoted as text.
  const originalBody = async () => (m.html && await get(`/mail/messages/${uid}/quote?folder=${enc(folder)}`).then((r) => r.html).catch(() => null)) || textToHtml(m.text);
  const quoted = async () => `<p></p><p>On ${escapeHtml(new Date(m.date).toLocaleString())}, ${escapeHtml(who(m.from))} wrote:</p><blockquote>${await originalBody()}</blockquote>`;
  const reSubject = (p) => (m.subject.toLowerCase().startsWith(p.toLowerCase()) ? m.subject : `${p} ${m.subject}`);
  // Reply from the address the message was sent to (e.g. sales@), if it is one of yours.
  const mine = (mailStatus?.identities || []).map((i) => i.address);
  const replyFrom = shared ? shared.address : [...m.to, ...m.cc].map((a) => a.address).find((a) => mine.includes(a)) || user.username;
  const thread = { inReplyTo: m.messageId, references: m.references, replyTo: { folder, uid }, from: replyFrom };
  const replyTo = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  const others = [...m.to, ...m.cc].filter((a) => !mine.includes(a.address) && a.address !== user.username && !replyTo.some((r) => r.address === a.address));
  // Done with it: back to the list, or (when it has gone from here) to the next one, by your setting.
  const done = async (p, b, msg) => { if (await act(p, { uids: [uid], ...b }, msg)) (p === 'flags' ? onClose : onRemoved || onClose)(); };
  // Mute: replies in this conversation skip the Inbox from now on; this message goes to Archive.
  const mute = async () => {
    try {
      const r = await post('/mail/muted', { message_id: m.messageId, references: m.references, subject: m.subject });
      setMuted(r.id);
      if (special === '\\Archive') toast('Muted: replies go straight to Archive');
      else done('move', { to: 'archive' }, 'Muted: this conversation is archived, and replies go straight to Archive');
    } catch (e) { toast(e.message, 'error'); }
  };
  const unmute = async () => { try { await del(`/mail/muted/${muted}`); setMuted(null); toast('Unmuted: replies come to the Inbox again'); } catch (e) { toast(e.message, 'error'); } };
  const answerReceipt = async (send) => {
    try { await post(`/mail/messages/${uid}/receipt`, { folder, send }); setM({ ...m, receipt: null }); if (send) toast(`Read receipt sent to ${m.receipt.to}`); } catch (e) { toast(e.message, 'error'); }
  };
  const attUrl = (a, view) => `/api/mail/messages/${uid}/attachments/${a.index}?folder=${enc(folder)}${view ? '&view' : ''}${mailboxParam()}`;
  const saveToDrive = async (indexes) => {
    try {
      const r = await post(`/mail/messages/${uid}/attachments/save`, { folder, ...(indexes && { indexes }) });
      toast(r.files.length === 1 ? `Saved ${r.files[0].name} to Drive` : `Saved ${r.files.length} files to Drive`, 'info',
        { action: { label: 'Show', onClick: () => navigate(`/drive/folder/${r.folder_id}`) } });
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <article className="reader">
      <div className="reader-actions">
        <button className="icon-btn mobile-only" aria-label="Back to list" onClick={onClose}><Icon name="back" /></button>
        {special !== '\\Archive' && <button className="icon-btn" aria-label="Archive" title="Archive" onClick={() => done('move', { to: 'archive' }, 'Archived')}><Icon name="archive" /></button>}
        {special === '\\Junk'
          ? <button className="btn small" onClick={() => done('move', { to: 'inbox' }, 'Moved to Inbox')}>Not spam</button>
          : <button className="icon-btn" aria-label="Report spam" title="Report spam" onClick={() => done('move', { to: 'junk' }, 'Moved to Junk')}><Icon name="report" /></button>}
        <button className="icon-btn" aria-label="Delete" title="Delete" onClick={() => done('delete', {}, special === '\\Trash' ? 'Deleted forever' : 'Moved to Trash')}><Icon name="trash" /></button>
        <button className="icon-btn" aria-label="Mark unread" title="Mark unread" onClick={() => done('flags', { seen: false })}><Icon name="markunread" /></button>
        <button className="icon-btn" aria-label="Print" title="Print (or save as PDF)" onClick={() => printMessage(m, { images })}><Icon name="print" /></button>
        <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="More for this message" title="More" {...p}><Icon name="more" /></button>} items={[
          { label: 'Show original', icon: 'search', onClick: () => setOriginal(true) },
          { label: 'Download message (.eml)', icon: 'download', onClick: () => { window.location.href = `/api/mail/messages/${uid}/eml?folder=${enc(folder)}${mailboxParam()}`; } },
        ]} />
        <button className="icon-btn" aria-label="Create event" title="Create an event from this email" onClick={() => navigate('/calendar', { state: { newEvent: eventFromEmail(m, [user.username, ...mine]) } })}><Icon name="calendar" /></button>
        <button className="icon-btn" aria-label="Add to Tasks" title="Add to Tasks" onClick={() => addToTasksWithToast(toast, navigate, { title: m.subject || '(no subject)', link: { url: mailLink({ ...m, folder, uid }), label: `Email from ${m.from ? who(m.from) : 'unknown sender'}` } })}><Icon name="check" /></button>
        {!shared && <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Labels" title="Labels" {...p}><LabelGlyph /></button>} items={[
          ...labels.map((l) => {
            const on = (m.labels || []).includes(l.id);
            return { label: `${on ? '✓ ' : ''}${l.name}`, onClick: async () => { if (await act('labels', { uids: [uid], [on ? 'remove' : 'add']: [l.id] })) setM({ ...m, labels: on ? m.labels.filter((x) => x !== l.id) : [...(m.labels || []), l.id] }); } };
          }),
          ...(labels.length ? ['-'] : []),
          { label: 'New label…', icon: 'plus', onClick: onNewLabel },
        ]} />}
        {!shared && <SnoozeMenu onPick={(at) => done('snooze', { until: at }, `Snoozed until ${whenText(at)}`)} onCustom={() => onSnoozeCustom([uid])} />}
        {folder === SNOOZED && <button className="btn small" onClick={() => done('unsnooze', {}, 'Back in the Inbox')}>Unsnooze</button>}
        <button className={`icon-btn ${m.flagged ? 'starred' : ''}`} aria-label={m.flagged ? 'Unstar' : 'Star'} aria-pressed={m.flagged} title="Star"
          onClick={async () => { if (await act('flags', { uids: [uid], flagged: !m.flagged })) setM({ ...m, flagged: !m.flagged }); }}>
          <span aria-hidden="true" style={{ fontSize: 20 }}>{m.flagged ? '★' : '☆'}</span>
        </button>
        {!shared && m.from?.address && <button className="btn small" onClick={() => onFilter(m.from.address)}>Filter messages like this</button>}
        {!shared && m.from?.address && special !== '\\Junk' && <button className="btn small" onClick={() => setBlocking(true)}>Block sender</button>}
        {!shared && m.messageId && !muted && <button className="btn small" title="Replies in this conversation skip the Inbox" onClick={mute}>Mute</button>}
      </div>
      {muted && <div className="banner" role="status">🔕 This conversation is muted: replies go straight to Archive. <button type="button" className="link-btn" onClick={unmute}>Unmute</button></div>}
      <h1 className="reader-subject">{m.subject || '(no subject)'}</h1>
      {shared && !shared.delegated && m.messageId && <AssignBar m={m} onChanged={(a) => { setM({ ...m, ...a }); onChanged(); }} />}
      {shared && !shared.delegated && m.messageId && <InternalNotes messageId={m.messageId} onChanged={onChanged} />}
      {(m.labels || []).length > 0 && (
        <div className="reader-labels">
          {m.labels.map((id) => labels.find((l) => l.id === id)).filter(Boolean).map((l) => (
            <LabelChip key={l.id} label={l} onRemove={async () => { if (await act('labels', { uids: [uid], remove: [l.id] })) setM({ ...m, labels: m.labels.filter((x) => x !== l.id) }); }} />
          ))}
        </div>
      )}
      {m.spam && <div className="banner warn">This message was marked as likely spam. Be careful with links and attachments.</div>}
      {blocking && (
        <ConfirmModal title={`Block ${m.from.address}?`} confirm="Block"
          message="Their messages will go straight to Junk, marked read, from now on (on your phone too). This one moves to Junk now. You can undo it in Filters."
          onClose={() => setBlocking(false)}
          onConfirm={async () => {
            try {
              await post('/mail/block', { address: m.from.address });
              setBlocking(false);
              done('move', { to: 'junk' }, `Blocked ${m.from.address}: their mail goes to Junk`);
            } catch (e) { toast(e.message, 'error'); }
          }} />
      )}
      {unsubscribing && (
        <ConfirmModal title={`Unsubscribe from ${m.from?.name || m.from?.address || 'this list'}?`} confirm="Unsubscribe"
          message={m.unsubscribe.how === 'one-click'
            ? 'The list is told to stop sending you mail. It may take a few days to stop.'
            : `An unsubscribe email is sent from your address to ${m.unsubscribe.to}. It may take a few days to stop.`}
          onClose={() => setUnsubscribing(false)}
          onConfirm={async () => {
            try {
              const r = await post(`/mail/messages/${uid}/unsubscribe`, { folder });
              setUnsubscribing(false);
              toast(r.how === 'email' ? `Unsubscribe email sent to ${r.to}` : 'Unsubscribed');
            } catch (e) { toast(e.message, 'error'); }
          }} />
      )}
      <Conversation folder={folder} uid={uid} date={m.date} onOpen={onOpen} />
      <div className="reader-head">
        <Avatar name={who(m.from)} size={40} email={m.from?.address} />
        <div className="grow">
          <div><strong>{m.from?.name || m.from?.address}</strong> {m.from?.name && <span className="muted small">&lt;{m.from.address}&gt;</span>} {m.from?.address && <SenderContact from={m.from} />}
            {m.unsubscribe && (m.unsubscribe.how === 'link'
              ? <a className="link-btn small unsub" href={m.unsubscribe.url} target="_blank" rel="noopener noreferrer nofollow" title="Opens the list's own page to unsubscribe">Unsubscribe</a>
              : <button type="button" className="link-btn small unsub" onClick={() => setUnsubscribing(true)}>Unsubscribe</button>)}</div>
          {m.sentBy && <div className="muted small sent-by">sent by {m.sentBy.name || m.sentBy.address}{m.sentBy.name ? ` <${m.sentBy.address}>` : ''}</div>}
          <div className="muted small">to {list(m.to) || '—'}{m.cc.length > 0 && <> · cc {list(m.cc)}</>}</div>
        </div>
        <span className="muted small nowrap">{m.date ? new Date(m.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
      </div>
      <FollowUpBanner messageId={m.messageId} />
      {m.invite && <InviteCard invite={m.invite} uid={uid} folder={folder} onChange={(invite) => setM({ ...m, invite })} />}
      {special === '\\Sent' && !shared && m.messageId && <DeliveryStatus messageId={m.messageId} />}
      {m.receipt && (
        <div className="banner receipt-ask" role="region" aria-label="Read receipt">
          <span className="grow">{who(m.from)} asked to be told when you've opened this message.</span>
          <button type="button" className="btn small" onClick={() => answerReceipt(true)}>Send receipt</button>
          <button type="button" className="btn small" onClick={() => answerReceipt(false)}>Not now</button>
        </div>
      )}
      {(() => {
        const fold = m.trimmed && !wholeQuote;
        const body = m.html ? <HtmlBody html={fold && m.trimmed.html !== null ? m.trimmed.html : m.html} images={images} onShowImages={() => setImages(true)} />
          : <pre className="mail-text">{fold && m.trimmed.text !== null ? m.trimmed.text : m.text}</pre>;
        return <>{body}{m.trimmed && (
          <button type="button" className="quote-toggle" aria-expanded={wholeQuote} aria-label={wholeQuote ? 'Hide quoted text' : 'Show quoted text'}
            title={wholeQuote ? 'Hide the earlier messages quoted in this one' : 'Show the earlier messages quoted in this one'} onClick={() => setWholeQuote(!wholeQuote)}>•••</button>
        )}</>;
      })()}
      {m.attachments.length > 0 && (
        <ul className="att-list">
          {m.attachments.map((a) => (
            <li key={a.index}><a className="att" href={attUrl(a)} title={previewKind(a.filename) ? 'Open (Shift+click to download)' : 'Download'}
              onClick={(e) => { if (previewKind(a.filename) && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setViewing(m.attachments.indexOf(a)); } }}>
              <Icon name="attach" size={18} /><span className="ellipsis">{a.filename}</span><span className="muted small">{formatBytes(a.size)}</span>
            </a><button type="button" className="icon-btn" aria-label={`Save ${a.filename} to Drive`} title="Save to Drive" onClick={() => saveToDrive([a.index])}><Icon name="folder" size={16} /></button></li>
          ))}
          {m.attachments.length > 1 && <li><a className="btn small" href={`/api/mail/messages/${uid}/attachments.zip?folder=${enc(folder)}${mailboxParam()}`} download>Download all (.zip)</a></li>}
          {m.attachments.length > 1 && <li><button type="button" className="btn small" onClick={() => saveToDrive(null)}>Save all to Drive</button></li>}
        </ul>
      )}
      {viewing !== null && m.attachments[viewing] && <FileViewer items={m.attachments.map((x) => ({ ...x, key: x.index }))} at={viewing}
        urls={{ view: (x) => attUrl(x, true), download: (x) => attUrl(x), office: (x) => `/mail/messages/${uid}/attachments/${x.index}/preview?folder=${enc(folder)}`, zip: (x) => `/mail/messages/${uid}/attachments/${x.index}/zip?folder=${enc(folder)}`, eml: (x) => `/mail/messages/${uid}/attachments/${x.index}/eml?folder=${enc(folder)}` }}
        onStep={(dir) => setViewing(stepPreview(m.attachments, viewing, dir))} onSave={(x) => saveToDrive([x.index])} onClose={() => setViewing(null)} />}
      {original && <OriginalDialog uid={uid} folder={folder} onClose={() => setOriginal(false)} />}
      <div className="row wrap reader-reply">
        <button className="btn" onClick={async () => onCompose({ to: list(replyTo), subject: reSubject('Re:'), html: await quoted(), ...thread })}><Icon name="reply" size={18} /> Reply</button>
        {others.length > 0 && <button className="btn" onClick={async () => onCompose({ to: list(replyTo), cc: list(others), subject: reSubject('Re:'), html: await quoted(), ...thread })}><Icon name="replyall" size={18} /> Reply all</button>}
        <button className="btn" onClick={() => onCompose({
          from: replyFrom, subject: reSubject('Fwd:'), html: '<p></p>',
          forwardOf: { folder, uid, asEml: true, attachments: [], eml: { filename: `${(m.subject || 'message').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'message'}.eml` } },
        })}><Icon name="attach" size={18} /> Forward as attachment</button>
        <button className="btn" onClick={async () => {
          const body = await originalBody();
          onCompose({
            from: replyFrom,
            ...(m.attachments.length > 0 && { forwardOf: { folder, uid, attachments: m.attachments.map((a) => a.index), files: m.attachments } }),
            subject: reSubject('Fwd:'),
            html: `<p></p><p>---------- Forwarded message ----------<br>From: ${escapeHtml(list([m.from]))}<br>Date: ${escapeHtml(new Date(m.date).toLocaleString())}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(list(m.to))}</p>${body}`,
          });
        }}><Icon name="forward" size={18} /> Forward</button>
      </div>
    </article>
  );
}

/** Beside the sender: "Add to contacts", or that they're already a contact (or a colleague). */
/** The rest of the conversation (same subject without Re:/Fwd:, someone in common), earlier and later, from any folder. */
function Conversation({ folder, uid, date, onOpen }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { get(`/mail/messages/${uid}/conversation?folder=${enc(folder)}`).then(setList).catch(() => setList([])); }, [folder, uid]);
  if (!list?.length) return null;
  const earlier = list.filter((x) => (x.date || 0) <= (date || 0)).length;
  const later = list.length - earlier;
  const summary = [earlier && `${earlier} earlier`, later && `${later} later`].filter(Boolean).join(', ');
  return (
    <div className="conversation">
      <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Conversation: {summary} message{list.length === 1 ? '' : 's'}</button>
      {open && (
        <ol className="conversation-list" aria-label="Conversation">
          {list.map((x) => (
            <li key={`${x.folder}:${x.uid}`} className={x.seen ? '' : 'unread'}>
              <button type="button" onClick={() => onOpen?.(x.folder, x.uid)}>
                <strong>{who(x.from)}</strong>
                <span className="muted small grow ellipsis">{x.subject}</span>
                {x.folder !== folder && <span className="pill small">{x.folder === 'INBOX' ? 'Inbox' : x.folder}</span>}
                <span className="muted small">{new Date(x.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const IMPORT_FROM = [['', 'Another mail server'], ['imap.gmail.com', 'Gmail'], ['outlook.office365.com', 'Outlook.com / Microsoft 365'], ['imap.mail.yahoo.com', 'Yahoo Mail'], ['imap.mail.me.com', 'iCloud Mail']];

/** Copy the mail of another account (all its folders) into this mailbox, with progress. */
function ImportMail({ onClose, onDone }) {
  const [job, setJob] = useState(undefined);
  const [f, setF] = useState({ host: '', port: 993, username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/mail/import').then(setJob).catch(() => setJob(null)); }, []);
  useEffect(() => onLive((m) => { if (m.type === 'mail-import') { setJob(m.import); if (m.import?.status === 'done') onDone(); } }), [onDone]);
  const start = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try { setJob(await post('/mail/import', f)); setF((x) => ({ ...x, password: '' })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const runningNow = job?.status === 'running';
  // From an .mbox file (Gmail's Takeout, Thunderbird, Apple Mail): uploaded to Drive first, or picked there.
  const [picking, setPicking] = useState(false);
  const fileInput = useRef();
  const fromFile = async (fileId) => {
    setError(''); setBusy(true);
    try { setJob(await post('/mail/import-mbox', { file_id: fileId })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const uploadMbox = async (file) => {
    if (!file) return;
    if (!/\.mbox$/i.test(file.name)) { setError('Choose an .mbox file'); return; }
    setError(''); setBusy(true);
    try { const up = await uploadFile(file, null); await fromFile(up.id); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title="Import mail" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>{runningNow ? 'Close (it carries on)' : 'Close'}</button>}>
      <div className="stack">
        {job && (
          <div className={`import-status ${job.status}`} role="status">
            {job.status === 'running' && <>Importing from <strong>{job.username}</strong>{job.folder ? ` · ${job.folder}` : ''}: {job.copied} of {job.total || '…'} copied{job.skipped ? `, ${job.skipped} already here` : ''}
              <progress max={job.total || 1} value={job.copied + job.skipped} /></>}
            {job.status === 'done' && <>Done: <strong>{job.copied}</strong> message{job.copied === 1 ? '' : 's'} copied from {job.username}{job.skipped ? `, ${job.skipped} already here` : ''}.</>}
            {job.status === 'failed' && <span className="error">The import from {job.username} stopped: {job.error}</span>}
          </div>
        )}
        {!runningNow && (
          <form className="stack" onSubmit={start}>
            <p className="muted small" style={{ margin: 0 }}>Copies all the mail in another account (every folder, with what's read and starred, and the dates) into this mailbox. Junk and Trash are left out. Messages already here are skipped, so you can run it again later. Your password there is used for this import only and never kept. Gmail, Yahoo and iCloud need an <em>app password</em> made in that account's security settings.</p>
            <label className="field"><span>Import from</span>
              <select aria-label="Import from" value={IMPORT_FROM.some(([h]) => h === f.host) ? f.host : ''} onChange={(e) => setF({ ...f, host: e.target.value, port: 993 })}>
                {IMPORT_FROM.map(([h, n]) => <option key={n} value={h}>{n}</option>)}
              </select></label>
            <div className="row">
              <label className="field grow"><span>Mail server (IMAP)</span><input required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} placeholder="imap.example.com" /></label>
              <label className="field" style={{ width: 110 }}><span>Port</span><select aria-label="Port" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })}><option value={993}>993 (secure)</option><option value={143}>143</option></select></label>
            </div>
            <label className="field"><span>Your user name there</span><input required autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="you@example.com" /></label>
            <label className="field"><span>Your password there</span><input required type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
            {error && <p className="error">{error}</p>}
            <div className="row end"><button className="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Start importing'}</button></div>
          </form>
        )}
        {!runningNow && (
          <fieldset className="stack import-mbox">
            <legend>Or from an .mbox file</legend>
            <p className="muted small" style={{ margin: 0 }}>Gmail's Takeout, Thunderbird, Apple Mail and Workspace's own <em>Download your data</em> give your mail as .mbox files. Its messages go into a folder named after the file (<em>Inbox.mbox</em> into the Inbox, <em>Sent.mbox</em> into Sent), with their dates and what's read and starred. An uploaded file is kept in your Drive.</p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => fileInput.current.click()}>Upload an .mbox file…</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setPicking(true)}>Choose from Drive…</button>
              <input ref={fileInput} type="file" accept=".mbox,application/mbox" hidden aria-label="An .mbox file" onChange={(e) => { uploadMbox(e.target.files[0]); e.target.value = ''; }} />
            </div>
          </fieldset>
        )}
        {picking && <DrivePicker title="Import an .mbox file" accept={(x) => x.kind === 'file' && /\.mbox$/i.test(x.name)} empty="No .mbox files found. Upload one first." onClose={() => setPicking(false)} onPick={(x) => { setPicking(false); fromFile(x.id); }} />}
      </div>
    </Modal>
  );
}

function SenderContact({ from }) {
  const toast = useToast();
  const [state, setState] = useState(null); // { contact, colleague }
  useEffect(() => {
    let live = true;
    get(`/contacts/lookup?email=${encodeURIComponent(from.address)}`).then((r) => live && setState(r)).catch(() => {});
    return () => { live = false; };
  }, [from.address]);
  if (!state || state.colleague) return null;
  if (state.contact) return <span className="pill sender-known" title={`${state.contact.name} is in your contacts`}>In your contacts</span>;
  return (
    <button type="button" className="link-btn small" onClick={async () => {
      try {
        const name = (from.name || from.address.split('@')[0]).trim();
        const c = await post('/contacts', { name, email: from.address });
        setState({ contact: { id: c.id, name: c.name }, colleague: false });
        toast(`${c.name} added to your contacts`);
      } catch (e) { toast(e.message, 'error'); }
    }}>Add to contacts</button>
  );
}

/** Your confidential messages: who they went to, until when, how often they were opened; take one back. */
/** Every newsletter and list in the Inbox (last 6 months) by sender, to leave in one click and clear out. */
/** Mailbox storage: how much room mail takes (against the limit, if there is one), by folder, and the largest messages to delete. */
function MailStorage({ onClose, onOpen }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const load = useCallback(() => get('/mail/storage').then(setS).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  const empty = async (f) => {
    if (!window.confirm(`Delete everything in ${f.name} for good? This can't be undone.`)) return;
    try { const r = await post('/mail/folders/empty', { folder: f.path }); toast(`${r.deleted} message${r.deleted === 1 ? '' : 's'} deleted for good: ${formatBytes(f.size)} freed`); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async (m) => {
    try { await post('/mail/messages/delete', { folder: m.folder, uids: [m.uid] }); toast(m.folder_special === '\\Trash' ? 'Deleted for good' : 'Moved to Trash: empty Trash to free the space'); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal wide title="Mailbox storage" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      {!s ? <p className="muted">Adding it up…</p> : (
        <div className="stack">
          <div className="stack-tight">
            <p style={{ margin: 0 }}><strong>{formatBytes(s.used)}</strong>{s.limit ? ` of ${formatBytes(s.limit)} used (${s.percent}%)` : ' used'}</p>
            {s.limit && <div className={`usage-bar mail-usage ${s.percent >= 90 ? 'warn' : ''}`} role="meter" aria-label="Mailbox used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.percent}><div style={{ width: `${s.percent}%` }} /></div>}
            {s.percent >= 90 && <p className="small" role="status" style={{ margin: 0, color: 'var(--danger)' }}>Your mailbox is nearly full: when it is, new mail is sent back to whoever wrote it.</p>}
          </div>
          <table className="files report" aria-label="Folders by size">
            <thead><tr><th>Folder</th><th className="num">Messages</th><th className="num">Size</th></tr></thead>
            <tbody>{s.folders.map((f) => <tr key={f.path}><td>{f.name}
              {(f.special === '\\Trash' || f.special === '\\Junk') && f.messages > 0 && <> <button type="button" className="link-btn small" onClick={() => empty(f)}>Empty</button></>}</td>
              <td className="num">{f.messages}</td><td className="num">{formatBytes(f.size)}</td></tr>)}</tbody>
          </table>
          <h3 style={{ margin: 0 }}>Largest messages</h3>
          {s.largest.length ? (
            <ul className="mail-storage-list" aria-label="Largest messages">
              {s.largest.map((m) => (
                <li key={`${m.folder}/${m.uid}`} className="row">
                  <span className="grow ellipsis"><strong>{m.subject || '(no subject)'}</strong> <span className="muted small">· {m.from?.name || m.from?.email || ''} · {m.folder_name}{m.date ? ` · ${formatDate(m.date)}` : ''}</span></span>
                  <span className="small nowrap">{formatBytes(m.size)}</span>
                  <button type="button" className="btn small" onClick={() => onOpen(m.folder, m.uid)}>Open</button>
                  <button type="button" className="icon-btn" aria-label={`Delete ${m.subject || 'message'}`} title="Delete" onClick={() => remove(m)}><Icon name="trash" size={18} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="muted" style={{ margin: 0 }}>No messages over {formatBytes(s.big_from)}.</p>}
          <p className="muted small" style={{ margin: 0 }}>Deleted mail stays in Trash (and counts) until Trash is emptied. Attachments you want to keep can go to Drive first (the folder button beside them).</p>
        </div>
      )}
    </Modal>
  );
}

function Subscriptions({ onClose }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [done, setDone] = useState({}); // address → what happened
  const load = () => get('/mail/subscriptions').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const leave = async (g) => {
    if (g.how === 'web') { window.open(g.url, '_blank', 'noopener'); setDone((d) => ({ ...d, [g.address]: 'Opened their page' })); return; }
    try {
      const r = await post(`/mail/messages/${g.uid}/unsubscribe`, { folder: 'INBOX' });
      setDone((d) => ({ ...d, [g.address]: r.how === 'email' ? 'Unsubscribe email sent' : 'Unsubscribed' }));
    } catch (e) { toast(e.message, 'error'); }
  };
  const archiveAll = async (g) => {
    try { await post('/mail/messages/move', { folder: 'INBOX', uids: g.uids, to: 'archive' }); toast(`${g.uids.length} ${g.uids.length === 1 ? 'message' : 'messages'} from ${g.name || g.address} archived`); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal wide title="Manage subscriptions" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Newsletters and mailing lists in your Inbox from the last six months, the busiest first. <strong>Unsubscribe</strong> asks the sender to stop (in one click where they allow it); <strong>Archive all</strong> clears their mail out of your Inbox.</p>
      {!list ? <p className="muted">Looking through your Inbox…</p> : !list.length ? <p className="muted">No newsletters or mailing lists in your Inbox.</p> : (
        <ul className="rule-list" aria-label="Subscriptions">
          {list.map((g) => (
            <li key={g.address}>
              <span className="grow"><strong>{g.name || g.address}</strong>
                <span className="muted small"> · {g.address} · {g.count} {g.count === 1 ? 'email' : 'emails'}, the latest {new Date(g.last_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></span>
              {done[g.address] ? <span className="pill ok">{done[g.address]}</span>
                : <button type="button" className="btn small" aria-label={`Unsubscribe from ${g.name || g.address}`} onClick={() => leave(g)}>{g.how === 'web' ? 'Unsubscribe ↗' : 'Unsubscribe'}</button>}
              <button type="button" className="btn small" aria-label={`Archive all from ${g.name || g.address}`} onClick={() => archiveAll(g)}>Archive all</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ConfidentialList({ onClose }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => get('/mail/confidential').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const STATE = { open: 'Readable', expired: 'Expired', revoked: 'Taken back' };
  return (
    <Modal wide title="Confidential messages" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>Messages you sent with 🔒 Confidential: their recipients read them on a page here until the date you chose. Take one back and nobody can read it any more.</p>
      {!list ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">None yet. Choose 🔒 Confidential when writing a message.</p> : (
        <ul className="rule-list" aria-label="Confidential messages">
          {list.map((m) => (
            <li key={m.token}>
              <span className="grow"><strong>{m.subject || '(No subject)'}</strong>
                <span className="muted small"> · to {m.recipients.join(', ')} · {STATE[m.state]}{m.state === 'open' ? ` until ${new Date(m.expires_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : ''} · opened {m.opened} time{m.opened === 1 ? '' : 's'}</span></span>
              {m.state === 'open' && <button type="button" className="btn small" aria-label={`Take back ${m.subject}`} onClick={async () => {
                try { await post(`/mail/confidential/${m.token}/revoke`); toast('Taken back: nobody can read it now'); load(); } catch (e) { toast(e.message, 'error'); }
              }}>Take back</button>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** HTML mail in a locked-down iframe: no scripts, no same-origin access, remote images blocked until asked. */
function HtmlBody({ html, images, onShowImages }) {
  const ref = useRef();
  const [height, setHeight] = useState(300);
  const hasRemote = useMemo(() => /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html), [html]);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${images ? ' https: http:' : ''}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f1f1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <>
      {hasRemote && !images && (
        <div className="banner">Images from the internet are hidden to protect your privacy. <button className="btn small" onClick={onShowImages}>Show images</button></div>
      )}
      <iframe ref={ref} className="mail-html" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" srcDoc={doc} style={{ height }}
        onLoad={() => { try { setHeight(Math.min(20000, ref.current.contentDocument.documentElement.scrollHeight + 16)); } catch { setHeight(800); } }} />
    </>
  );
}

const FIELDS = ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo', 'references', 'replyTo'];

// Attaching a document, spreadsheet or presentation: as which kind of file (a copy as it is now, kept in Email attachments).
const ATTACH_AS = {
  doc: [['docx', 'Word (.docx)'], ['odt', 'OpenDocument (.odt)'], ['md', 'Markdown (.md)'], ['epub', 'E-book (.epub)']],
  sheet: [['xlsx', 'Excel (.xlsx)'], ['ods', 'OpenDocument (.ods)']],
  slides: [['pptx', 'PowerPoint (.pptx)'], ['odp', 'OpenDocument (.odp)']],
};
/** "Show original": what the message's headers say (who sent it and how it was checked, the servers it passed through) and the headers themselves. */
function OriginalDialog({ uid, folder, onClose }) {
  const toast = useToast();
  const [o, setO] = useState(null);
  useEffect(() => { get(`/mail/messages/${uid}/original?folder=${encodeURIComponent(folder)}`).then(setO).catch((e) => { toast(e.message, 'error'); onClose(); }); }, [uid, folder]); // eslint-disable-line react-hooks/exhaustive-deps
  const verdict = (v) => (v ? <span className={`auth-${['pass', 'none', 'neutral'].includes(v) ? v : 'fail'}`}>{v.toUpperCase()}</span> : <span className="muted">not checked</span>);
  const secs = (ms) => (ms == null ? '' : ms < 1000 ? 'under a second' : `${Math.round(ms / 1000)} s`);
  return (
    <Modal wide title="Original message" onClose={onClose} footer={<>
      <a className="btn" href={`/api/mail/messages/${uid}/eml?folder=${encodeURIComponent(folder)}${mailboxParam()}`}>Download message (.eml)</a>
      <button type="button" className="btn" onClick={() => { navigator.clipboard?.writeText(o?.headers || '').then(() => toast('Headers copied'), () => {}); }} disabled={!o}>Copy headers</button>
      <button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      {!o ? <p className="muted">Loading…</p> : (
        <div className="stack">
          <table className="original-summary"><tbody>
            <tr><th scope="row">Message ID</th><td><code>{o.messageId || '—'}</code></td></tr>
            <tr><th scope="row">Written</th><td>{o.date ? new Date(o.date).toLocaleString() : '—'}</td></tr>
            <tr><th scope="row">From</th><td>{o.from || '—'}</td></tr>
            <tr><th scope="row">To</th><td>{o.to || '—'}</td></tr>
            <tr><th scope="row">SPF</th><td>{verdict(o.spf)}</td></tr>
            <tr><th scope="row">DKIM</th><td>{verdict(o.dkim)}</td></tr>
            <tr><th scope="row">DMARC</th><td>{verdict(o.dmarc)}</td></tr>
          </tbody></table>
          {o.hops.length > 0 && (
            <div><h3 className="small" style={{ margin: '4px 0' }}>The way it came</h3>
              <ol className="original-hops">{o.hops.map((h, i) => <li key={i}>{h.from || '?'} → {h.by || '?'}{h.at ? <span className="muted small"> · {new Date(h.at).toLocaleString()}{h.delay != null ? ` (${secs(h.delay)} later)` : ''}</span> : null}</li>)}</ol>
            </div>
          )}
          <label className="field"><span>Headers ({Math.round(o.size / 1024) || 1} KB message)</span>
            <textarea readOnly rows={14} className="original-headers" value={o.headers} aria-label="Headers" /></label>
        </div>
      )}
    </Modal>
  );
}

function AttachAs({ file, onClose, onDone, onLink }) {
  const toast = useToast();
  const { user } = useAuth();
  const choices = ATTACH_AS[file.kind] || [];
  // Your usual kind first (Settings → File format for downloads).
  const [format, setFormat] = useState((user.file_format === 'odf' && choices.find(([v]) => v.startsWith('od'))?.[0]) || choices[0]?.[0]);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (format === 'link') { onLink(file); return; }
    setBusy(true);
    try { onDone(await post(`/files/${file.id}/export-copy`, { format })); } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title={`Attach “${file.name}”`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={go}>{busy ? 'Attaching…' : format === 'link' ? 'Insert link' : 'Attach'}</button></>}>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="muted small">Attach it as</legend>
        {choices.map(([v, label]) => <label key={v} className="check"><input type="radio" name="attach-as" value={v} checked={format === v} onChange={() => setFormat(v)} /> {label}</label>)}
        <label className="check"><input type="radio" name="attach-as" value="link" checked={format === 'link'} onChange={() => setFormat('link')} /> A link to it (in the message)</label>
      </fieldset>
      <p className="muted small">{format === 'link'
        ? 'Colleagues open it in Workspace and always see the latest version. If some of them can’t open it, you’re asked about sharing it when you send.'
        : `A copy as it is now goes with the email (and into your Email attachments folder). Later changes to the ${file.kind === 'sheet' ? 'spreadsheet' : file.kind === 'slides' ? 'presentation' : 'document'} aren't in it.`}</p>
    </Modal>
  );
}

function Compose({ initial, shared = null, signatures = [], onClose, onSent, onDraftsChanged }) {
  const editorRef = useRef(null);
  const toast = useToast();
  const { user } = useAuth();
  const [identities, setIdentities] = useState([{ address: user.username }]);
  const [f, setF] = useState(() => {
    const base = { from: user.username, to: '', cc: '', bcc: '', subject: '', text: '', html: '' };
    for (const k of FIELDS) if (initial[k] !== undefined && initial[k] !== null) base[k] = initial[k];
    if (shared) base.from = shared.address; // a shared mailbox sends only as itself
    return base;
  });
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [receipt, setReceipt] = useState(false); // ask for a read receipt
  const [followUp, setFollowUp] = useState(''); // days: remind me if nobody replies by then
  const [confidential, setConfidential] = useState(''); // days it can be read (the email carries a link, not the message)
  const [files, setFiles] = useState(initial.files || []);
  // Attachments carried over from a forwarded message (attached by the server from the original).
  const [fwd, setFwd] = useState(initial.forwardOf || null);
  const [draftState, setDraftState] = useState(initial.draftUid ? 'saved' : '');

  // ---- autosave to the Drafts folder: debounced, one save at a time, each replacing the previous copy ----
  const draftUid = useRef(initial.draftUid || null);
  const chain = useRef(Promise.resolve());
  const timer = useRef(null);
  const dirty = useRef(false);
  const closed = useRef(false);
  const latest = useRef({ f, files });
  latest.current = { f, files, fwd };

  const saveDraft = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current || closed.current) return chain.current;
    dirty.current = false;
    const { f: cur, files: att, fwd: fw } = latest.current;
    const empty = !cur.to.trim() && !cur.cc.trim() && !cur.bcc.trim() && !cur.subject.trim() && !cur.text.trim() && !att.length;
    if (empty && !draftUid.current) return chain.current;
    chain.current = chain.current.then(async () => {
      setDraftState('saving');
      try {
        const r = await post('/mail/drafts', { ...cur, attachments: att.map((x) => x.id), uid: draftUid.current, forwardOf: fw });
        draftUid.current = r.uid;
        setDraftState('saved');
      } catch { dirty.current = true; setDraftState('error'); }
    });
    return chain.current;
  }, []);

  const first = useRef(true);
  const skipNext = useRef(false); // the editor reporting its starting content is not an edit
  useEffect(() => {
    if (first.current || skipNext.current) { first.current = false; skipNext.current = false; return; }
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveDraft, 2000);
  }, [f, files, fwd, saveDraft]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function closeKeep() {
    if (busy) return;
    await saveDraft();
    closed.current = true;
    if (draftUid.current) { toast('Draft saved'); onDraftsChanged?.(); }
    onClose();
  }
  async function discard() {
    closed.current = true;
    clearTimeout(timer.current);
    await chain.current;
    if (draftUid.current) { await del(`/mail/drafts/${draftUid.current}`).catch(() => {}); onDraftsChanged?.(); toast('Draft discarded'); }
    onClose();
  }
  const [picking, setPicking] = useState(false);
  const [converting, setConverting] = useState(initial.convert || null); // a document, spreadsheet or presentation picked to attach: which kind of file?
  const [templates, setTemplates] = useState([]);
  const [templateDialog, setTemplateDialog] = useState(null); // 'save' | 'manage'
  const loadTemplates = () => get('/mail/templates').then(setTemplates).catch(() => {});
  useEffect(() => { loadTemplates(); }, []);
  /** The message without its signature (that's added per address), as HTML. */
  const bodyHtml = () => { const d = document.createElement('div'); d.innerHTML = editorRef.current?.getHTML() || ''; d.querySelectorAll('[data-signature]').forEach((x) => x.remove()); return d.innerHTML; };
  /** Put a template in: its text where the cursor is (in place of an empty message), its subject if there's none yet. */
  const applyTemplate = (t) => {
    const ed = editorRef.current;
    if (!ed) return;
    const empty = !bodyHtml().replace(/<p><\/p>/g, '').trim();
    if (empty) ed.chain().focus('start').insertContentAt(0, t.html || '<p></p>').run();
    else ed.chain().focus().insertContent(t.html || '').run();
    if (t.subject && !f.subject.trim()) setF((cur) => ({ ...cur, subject: t.subject }));
  };
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { if (shared) setIdentities([{ address: shared.address, name: shared.name }]); else get('/mail/status').then((s) => setIdentities(s.identities)).catch(() => {}); }, [shared]);

  // Undo send: the window steps aside for a few seconds before the message really goes.
  const [waiting, setWaiting] = useState(false);
  const [accessGaps, setAccessGaps] = useState(null); // linked files some recipients can't open
  // A company data protection rule that warns: what it found, and whether the sender said to send anyway.
  const [dlpWarn, setDlpWarn] = useState(null); // { text, at }
  const dlpOk = useRef(false);
  const dlpStop = (err, at = null) => { if (err.status !== 409 || !err.data?.dlp) return false; reopen(); setDlpWarn({ text: err.message, at }); return true; };
  const pendingSend = useRef(null); // the send to do when the wait is over (or the page is left)
  useEffect(() => () => { pendingSend.current?.(); }, []); // leaving now sends straight away
  const [scheduling, setScheduling] = useState(false);
  const payload = () => ({ ...f, html: f.text.trim() ? emailHtml(f.html) : '', attachments: files.map((x) => x.id), linkAttachments: files.filter((x) => x.asLink).map((x) => x.id), draftUid: draftUid.current, forwardOf: fwd, receipt, ...(followUp && { followUp: Number(followUp) }), ...(confidential && { confidential: { days: Number(confidential) } }) });
  const stopAutosave = async () => {
    closed.current = true;          // no more autosaves
    clearTimeout(timer.current);
    await chain.current;            // let an in-flight save finish so the right draft gets removed
  };
  const reopen = () => { setWaiting(false); setBusy(false); closed.current = false; dirty.current = true; };

  const archiveAfter = useRef(false); // Send & archive was pressed
  async function send(e) {
    e.preventDefault();
    archiveAfter.current = e.nativeEvent?.submitter?.dataset?.archive === '1';
    // Only this form's own submit sends. Dialogs opened from the message (e.g. the link dialog) are
    // rendered elsewhere in the page, but React still passes their events up to here.
    if (e.target !== e.currentTarget) return;
    // Links to Drive files that colleagues it goes to can't open: ask first.
    const links = fileLinksIn(`${f.text} ${f.html}`).map((l) => l.id);
    const emails = [f.to, f.cc, f.bcc].flatMap((t) => parseAddresses(t).list.map((a) => a.email));
    if (links.length && emails.length) {
      try {
        const gaps = await post('/files/missing-access', { files: links, emails });
        if (gaps.length) { setAccessGaps(gaps); return; }
      } catch { /* checking is a courtesy */ }
    }
    reallySend();
  }
  /** Share the linked files you own with those who can't open them, then send. */
  async function shareAndSend() {
    const gaps = accessGaps;
    setAccessGaps(null);
    try {
      for (const g of gaps.filter((x) => x.can_share)) {
        const now = await get(`/files/${g.id}/shares`);
        const done = await withDataCheck((more) => put(`/files/${g.id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), ...g.people.map((p) => ({ user_id: p.id, role: 'viewer' }))], ...more }));
        if (done === undefined) { toast(`“${g.name}” wasn’t shared: the message wasn’t sent either`, 'info'); return; }
      }
    } catch (err) { toast(err.message, 'error'); return; }
    reallySend();
  }
  async function reallySend() {
    setBusy(true);
    await stopAutosave();
    const body = { ...payload(), ...(dlpOk.current && { dlpConfirmed: true }) };
    const mailbox = currentSharedMailbox(); // as it is now: leaving Mail (or switching mailbox) during the wait still sends from here
    const go = async () => {
      pendingSend.current = null;
      try {
        const r = await post('/mail/send', body, { mailbox });
        // Send & archive: the message replied to leaves the inbox once the reply is on its way.
        const archived = archiveAfter.current && body.replyTo?.uid
          ? await post('/mail/messages/move', { folder: body.replyTo.folder, uids: [body.replyTo.uid], to: 'archive' }, { mailbox }).then(() => true, () => false)
          : false;
        toast(`Sent to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}${archived ? ' and archived' : ''}`);
        onSent();
      } catch (err) { if (!dlpStop(err)) { toast(err.message, 'error'); reopen(); } }
    };
    pendingSend.current = go;
    setWaiting(true);
    const t = setTimeout(go, UNDO_SECONDS * 1000);
    toast('Sending…', 'info', { duration: UNDO_SECONDS * 1000, action: { label: 'Undo', onClick: () => { clearTimeout(t); pendingSend.current = null; reopen(); } } });
  }

  /** Send at a chosen time: the server keeps it and sends it then. */
  async function sendLater(at) {
    setBusy(true);
    await stopAutosave();
    try {
      const r = await post('/mail/send', { ...payload(), sendAt: at, ...(dlpOk.current && { dlpConfirmed: true }) });
      toast(`Will be sent ${whenText(at)}`, 'info', { action: { label: 'Undo', onClick: () => del(`/mail/scheduled/${r.scheduled.id}`).then(() => { toast('Not sent: it’s back in Drafts'); onDraftsChanged?.(); }).catch((err) => toast(err.message, 'error')) } });
      onSent();
    } catch (err) { if (!dlpStop(err, at)) { toast(err.message, 'error'); reopen(); } }
  }

  async function upload(list) {
    for (const file of list) {
      setUploading((n) => n + 1);
      try { const rec = await uploadFile(file, null); setFiles((x) => [...x, rec]); }
      catch (err) { toast(err.message, 'error'); }
      finally { setUploading((n) => n - 1); }
    }
  }

  const total = files.filter((x) => !x.asLink).reduce((s, x) => s + x.size, 0); // what's attached; links don't count
  const linkable = (x) => x.owner_id === user.id; // your own files can go as download links
  const setAsLink = (id, on) => setFiles((list) => list.map((y) => (y.id === id ? { ...y, asLink: on } : y)));
  return (
    <div hidden={waiting}>
    <Modal wide title={initial.draftUid ? 'Draft' : initial.subject ? initial.subject : 'New message'} onClose={waiting ? () => {} : closeKeep}>
      <form className="compose stack" onSubmit={send}>
        {identities.length > 1 && (
          <label className="compose-line"><span>From</span>
            <select aria-label="From" value={f.from} onChange={(e) => {
              const from = e.target.value;
              const kind = initial.kind || ((f.html || '').includes('<blockquote') ? 'reply' : 'new'); // resumed drafts
              if (editorRef.current) swapSignature(editorRef.current, signatureBlock(signatures, from, kind));
              setF((cur) => ({ ...cur, from }));
            }}>{identities.map((i) => <option key={i.address} value={i.address}>{i.address}</option>)}</select>
          </label>
        )}
        <label className="compose-line"><span>To</span><AddressInput label="To" autoFocus={!initial.to} type="text" inputMode="email" value={f.to} onChange={(v) => setF((x) => ({ ...x, to: v }))} placeholder="name@company.com, …" />
          {!showCc && <button type="button" className="link" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</label>
        {showCc && <>
          <label className="compose-line"><span>Cc</span><AddressInput label="Cc" type="text" inputMode="email" value={f.cc} onChange={(v) => setF((x) => ({ ...x, cc: v }))} /></label>
          <label className="compose-line"><span>Bcc</span><AddressInput label="Bcc" type="text" inputMode="email" value={f.bcc} onChange={(v) => setF((x) => ({ ...x, bcc: v }))} /></label>
        </>}
        <label className="compose-line"><span>Subject</span><input aria-label="Subject" value={f.subject} onChange={set('subject')} /></label>
        <RichBody initialHtml={initial.html || textToHtml(initial.text || '')} autoFocus={!!initial.to} onReady={(ed) => { editorRef.current = ed; }}
          onChange={(html, text, initialReport) => { if (initialReport) skipNext.current = true; setF((cur) => ({ ...cur, html, text })); }} />
        {fwd?.asEml && (
          <ul className="att-list" aria-label="Forwarded message">
            <li className="att"><Icon name="mail" size={18} /><span className="ellipsis">{fwd.eml?.filename || 'message.eml'}</span><span className="muted small">original message</span>
              <button type="button" className="icon-btn" aria-label="Remove the attached message" onClick={() => setFwd({ ...fwd, asEml: false })}><Icon name="close" size={16} /></button></li>
          </ul>
        )}
        {fwd?.attachments?.length > 0 && (
          <ul className="att-list" aria-label="Forwarded attachments">
            {(fwd.files || []).filter((x) => fwd.attachments.includes(x.index)).map((x) => (
              <li key={`fwd-${x.index}`} className="att"><Icon name="attach" size={18} /><span className="ellipsis">{x.filename}</span><span className="muted small">{formatBytes(x.size)}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${x.filename}`}
                  onClick={() => setFwd({ ...fwd, attachments: fwd.attachments.filter((i) => i !== x.index) })}><Icon name="close" size={16} /></button></li>
            ))}
          </ul>
        )}
        {(files.length > 0 || uploading > 0) && (
          <ul className="att-list">
            {files.map((x) => (
              <li key={x.id} className="att"><Icon name={x.asLink ? 'link' : 'attach'} size={18} /><span className="ellipsis">{x.name}</span><span className="muted small">{formatBytes(x.size)}</span>
                {linkable(x) && <label className="check small" title="Send a download link (for 30 days) instead of attaching the file"><input type="checkbox" checked={!!x.asLink} onChange={(e) => setAsLink(x.id, e.target.checked)} aria-label={`Send ${x.name} as a link`} /> As a link</label>}
                <button type="button" className="icon-btn" aria-label={`Remove ${x.name}`} onClick={() => setFiles(files.filter((y) => y.id !== x.id))}><Icon name="close" size={16} /></button></li>
            ))}
            {uploading > 0 && <li className="att muted">Uploading {uploading}…</li>}
          </ul>
        )}
        {total > 25 * 1024 * 1024 && (
          <p className="error small row" style={{ gap: 8 }}>Attachments are over 25 MB.
            {files.some((x) => !x.asLink && linkable(x))
              ? <button type="button" className="link-btn" onClick={() => setFiles((list) => list.map((y) => (linkable(y) && y.size >= 1024 * 1024 ? { ...y, asLink: true } : y)))}>Send the large files as links</button>
              : ' Share a Drive link instead.'}
          </p>
        )}
        {files.some((x) => x.asLink) && <p className="muted small" style={{ margin: 0 }}>Files sent as links go out as download links at the end of the message, for 30 days; anyone with the message can open them. You can remove a link from the file’s Share window.</p>}
        <div className="row">
          <div className="split-btn">
            <button className="btn primary" disabled={busy || uploading > 0 || !f.to.trim() || total > 25 * 1024 * 1024}><Icon name="send" size={18} /> {busy ? 'Sending…' : 'Send'}</button>
            {!shared && <Menu align="left" trigger={(p) => <button type="button" className="btn primary split-more" aria-label="Schedule for later" title="Schedule for later" disabled={busy || uploading > 0 || !f.to.trim() || total > 25 * 1024 * 1024} {...p}><Icon name="clock" size={16} /></button>}
              items={[...laterChoices().map(([label, at]) => ({ label: `${label} · ${whenText(at)}`, onClick: () => sendLater(at) })), '-', { label: 'Pick date and time…', icon: 'calendar', onClick: () => setScheduling(true) }]} />}
          </div>
          {f.replyTo?.uid && !/archive/i.test(f.replyTo.folder || '') && <button className="btn" data-archive="1" title="Send, and archive the message you're replying to" disabled={busy || uploading > 0 || !f.to.trim() || total > 25 * 1024 * 1024}><Icon name="archive" size={16} /> Send &amp; archive</button>}
          <button type="button" className="icon-btn" aria-label="Attach from computer" title="Attach from computer" onClick={() => fileInput.current.click()}><Icon name="attach" /></button>
          <button type="button" className="icon-btn" aria-label="Attach from Drive" title="Attach from Drive" onClick={() => setPicking(true)}><Icon name="folder" /></button>
          <label className="check small" title="The recipient's mail app may offer to tell you when they open it; they can say no"><input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} /> Read receipt</label>
          {!shared && <select className={`small followup-pick ${confidential ? 'on' : ''}`} aria-label="Confidential" title="Confidential: the email carries a link to the message, readable by its recipients until the date you choose (and you can take it back); no attachments" value={confidential} onChange={(e) => setConfidential(e.target.value)}>
            <option value="">Not confidential</option>
            {[[1, '1 day'], [7, '1 week'], [30, '1 month'], [90, '3 months']].map(([d, t]) => <option key={d} value={d}>🔒 Confidential, {t}</option>)}
          </select>}
          {!shared && <select className="small followup-pick" aria-label="Remind me if no reply" title="Get a notification if nobody has replied by then" value={followUp} onChange={(e) => setFollowUp(e.target.value)}>
            <option value="">No follow-up</option>
            {[[1, 'in 1 day'], [2, 'in 2 days'], [3, 'in 3 days'], [7, 'in a week'], [14, 'in 2 weeks']].map(([d, t]) => <option key={d} value={d}>⏰ No reply {t}</option>)}
          </select>}
          <Menu align="left" trigger={(p) => <button type="button" className="icon-btn" aria-label="Templates" title="Templates" {...p}><Icon name="doc" /></button>} items={[
            ...templates.map((t) => ({ label: t.name, onClick: () => applyTemplate(t) })),
            ...(templates.length ? ['-'] : []),
            { label: 'Save as template…', icon: 'plus', onClick: () => setTemplateDialog('save') },
            ...(templates.length ? [{ label: 'Manage templates…', icon: 'settings', onClick: () => setTemplateDialog('manage') }] : []),
          ]} />
          <input ref={fileInput} type="file" multiple hidden aria-label="Attachment files" onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
          <div className="grow" />
          <span className={`muted small draft-state ${draftState}`} aria-live="polite">
            {draftState === 'saving' ? 'Saving…' : draftState === 'saved' ? 'Draft saved' : draftState === 'error' ? 'Couldn’t save draft' : ''}
          </span>
          <button type="button" className="icon-btn" aria-label="Discard draft" title="Discard draft" onClick={discard}><Icon name="trash" /></button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Drafts save automatically. Files you attach from your computer are also saved to your Drive.</p>
      </form>
      {templateDialog === 'save' && <PromptModal title="Save as template" label="Template name" initial={f.subject} confirm="Save" onClose={() => setTemplateDialog(null)}
        onSubmit={async (name) => { await post('/mail/templates', { name, subject: f.subject, html: bodyHtml() }); toast(`Template “${name.trim()}” saved`); loadTemplates(); }} />}
      {templateDialog === 'manage' && <TemplatesDialog templates={templates} onClose={() => setTemplateDialog(null)} onChanged={loadTemplates} />}
      {picking && <DrivePicker empty="No files found." accept={(x) => x.kind !== 'folder'} onClose={() => setPicking(false)}
        onPick={(file) => { setPicking(false); if (file.kind !== 'file') { setConverting(file); return; } if (!files.some((x) => x.id === file.id)) setFiles([...files, file]); }} />}
      {converting && <AttachAs file={converting} onClose={() => setConverting(null)} onDone={(rec) => { setConverting(null); setFiles((x) => [...x, rec]); }}
        onLink={(fl) => {
          setConverting(null);
          const path = { doc: 'docs', sheet: 'sheets', slides: 'slides' }[fl.kind];
          const icon = { doc: '📄', sheet: '📊', slides: '📽' }[fl.kind] || '';
          editorRef.current?.chain().focus().insertContent([{ type: 'text', text: `${icon} ` }, { type: 'text', text: fl.name, marks: [{ type: 'link', attrs: { href: `${window.location.origin}/${path}/${fl.id}` } }] }, { type: 'text', text: ' ' }]).run();
        }} />}
    </Modal>
    {scheduling && <ScheduleDialog onClose={() => setScheduling(false)} onPick={(at) => { setScheduling(false); sendLater(at); }} />}
    {dlpWarn && (
      <Modal title="Check before sending" onClose={() => setDlpWarn(null)}>
        <div className="stack">
          <p style={{ margin: 0 }} role="alert">{dlpWarn.text}</p>
          <p className="muted small" style={{ margin: 0 }}>Your company asks you to check messages like this before they go. If you send it anyway, that’s recorded.</p>
          <div className="row end">
            <button type="button" className="btn" onClick={() => setDlpWarn(null)}>Edit message</button>
            <button type="button" className="btn primary" onClick={() => { const at = dlpWarn.at; dlpOk.current = true; setDlpWarn(null); if (at) sendLater(at); else reallySend(); }}>Send anyway</button>
          </div>
        </div>
      </Modal>
    )}
    {accessGaps && (
      <Modal title="Some recipients can't open a linked file" onClose={() => setAccessGaps(null)}>
        <div className="stack">
          <ul className="access-gaps">
            {accessGaps.map((g) => <li key={g.id}><strong>{g.name}</strong>: {g.people.map((p) => p.name).join(', ')}{!g.can_share && <span className="muted small"> (not yours to share; ask its owner)</span>}</li>)}
          </ul>
          <div className="row end">
            <button type="button" className="btn" onClick={() => setAccessGaps(null)}>Cancel</button>
            <button type="button" className="btn" onClick={() => { setAccessGaps(null); reallySend(); }}>Send anyway</button>
            {accessGaps.some((g) => g.can_share) && <button type="button" className="btn primary" onClick={shareAndSend}>Share (can view) and send</button>}
          </div>
        </div>
      </Modal>
    )}
    </div>
  );
}

function VacationDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { get('/mail/vacation').then((x) => setV({ ...x, start_date: x.start_date || '', end_date: x.end_date || '' })); }, []);
  if (!v) return null;
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Vacation reply" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return; // a dialog opened from inside (see Compose's send)
        try { const r = await put('/mail/vacation', v); toast(r.enabled ? 'Vacation reply saved' : 'Vacation reply off'); onSaved(r); }
        catch (err) { setError(err.message); }
      }}>
        <label className="check"><input type="checkbox" checked={v.enabled} onChange={set('enabled')} /> Send an automatic reply while I'm away</label>
        <div className="row wrap">
          <label className="field"><span>First day (optional)</span><input type="date" value={v.start_date} onChange={set('start_date')} /></label>
          <label className="field"><span>Last day (optional)</span><input type="date" value={v.end_date} min={v.start_date || undefined} onChange={set('end_date')} /></label>
        </div>
        <label className="field"><span>Subject</span><input value={v.subject} onChange={set('subject')} maxLength={200} /></label>
        <label className="field"><span>Message</span><textarea rows={6} value={v.body} onChange={set('body')} required={v.enabled}
          placeholder="I'm out of the office until Monday and will reply when I'm back." /></label>
        <p className="muted small" style={{ margin: 0 }}>Each person gets this reply at most once a day. Mailing lists, newsletters, spam and other automatic messages never get one.</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

/** Rich-text message body: bold, italic, underline, strike, lists, quotes, links. */
function RichBody({ initialHtml, onChange, onReady, autoFocus, label = 'Message', placeholder = 'Write your message…' }) {
  const [, force] = useState(0);
  const toast = useToast();
  const fileInput = useRef();
  const [uploading, setUploading] = useState(0);
  const edRef = useRef(null);
  const [editing, setEditing] = useState(null); // { pos, src, alt } of the picture open in the editor
  const [linking, setLinking] = useState(null); // { from, to, text, href } for the link dialog
  const linkOpen = useRef(() => {});

  // Pictures are uploaded to Drive, shown from there while writing, and embedded in the email when sent.
  async function insertImages(files, pos) {
    const images = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!images.length) return false;
    for (const file of images) {
      if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is larger than 10 MB`, 'error'); continue; }
      setUploading((n) => n + 1);
      try {
        const rec = await uploadFile(file, null);
        // Insert the picture followed by an empty line, and leave the cursor there, so typing or
        // pasting next doesn't replace the picture (an inserted image is otherwise left selected).
        const content = [{ type: 'image', attrs: { src: `/api/files/${rec.id}/raw`, alt: rec.name } }, { type: 'paragraph' }];
        const chain = edRef.current.chain().focus();
        (pos != null ? chain.insertContentAt(pos, content) : chain.insertContent(content)).run();
      } catch (e) { toast(e.message, 'error'); }
      finally { setUploading((n) => n - 1); }
    }
    return true;
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      Placeholder.configure({ placeholder }),
      ResizableImage.configure({ inline: false, allowBase64: false }),
      // Tables quoted from replies and forwards (or pasted). Column sizes follow the content.
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      // Text colours quoted from replies and forwards (or pasted). Clear formatting removes them.
      // Highlights are a background colour on the text (inline style), which every mail app shows.
      // Fonts are kept from quoted mail (the server only lets common mail fonts through).
      TextStyle, Color, BackgroundColor, FontSize, FontFamily,
      // Left / centre / right for paragraphs (Ctrl+Shift+L / E / R). Left is the normal alignment.
      TextAlign.configure({ types: ['paragraph'], alignments: ['left', 'center', 'right'] }),
      Indent,
      SignatureBlock,
    ],
    content: initialHtml,
    editorProps: {
      attributes: { class: 'tiptap', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (view, event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); linkOpen.current(); return true; }
        return false;
      },
      handlePaste: (view, event) => {
        const files = event.clipboardData?.files;
        if (files?.length && [...files].some((f) => f.type.startsWith('image/'))) { event.preventDefault(); insertImages(files); return true; }
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length || ![...files].some((f) => f.type.startsWith('image/'))) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImages(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const doc = ed.getJSON();
      onChange(isEmptyDoc(doc) ? '' : ed.getHTML(), docToText(doc));
    },
    onSelectionUpdate: () => force((n) => n + 1),
    onTransaction: () => force((n) => n + 1),
  });
  useEffect(() => {
    if (!editor) return;
    edRef.current = editor;
    onReady?.(editor);
    // Report the starting content (e.g. a quoted reply) so drafts and sending see it.
    const doc = editor.getJSON();
    onChange(isEmptyDoc(doc) ? '' : editor.getHTML(), docToText(doc), true);
    if (autoFocus) editor.commands.focus('start');
    // Double-clicking a picture opens the crop / rotate editor.
    const onEdit = () => openEditor(editor);
    editor.on('editPicture', onEdit);
    return () => editor.off('editPicture', onEdit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function openEditor(ed) {
    const sel = ed.state.selection;
    const node = sel.node;
    if (node?.type.name !== 'image') return;
    if (!editablePicture(node.attrs.src)) return toast('Only pictures you inserted can be edited', 'error');
    setEditing({ pos: sel.from, src: node.attrs.src, alt: node.attrs.alt });
  }
  // Swap in the edited picture, keeping its size. Ctrl+Z puts the original back.
  function applyEdit({ src, alt }) {
    const ed = edRef.current;
    const { pos } = editing;
    const node = ed.state.doc.nodeAt(pos);
    setEditing(null);
    if (node?.type.name !== 'image' || node.attrs.src !== editing.src) return toast('The picture was moved; edit it again', 'error');
    // Its own undo step, even right after another change to the picture.
    ed.view.dispatch(closeHistory(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src, alt })));
    ed.commands.setNodeSelection(pos);
    ed.commands.focus();
  }
  if (!editor) return null;
  const c = () => editor.chain().focus();
  // Link dialog: for the link the cursor is in (whole link), or for the selected text.
  linkOpen.current = () => {
    if (editor.isActive('link')) editor.chain().extendMarkRange('link').run();
    const { from, to } = editor.state.selection;
    setLinking({ from, to, text: editor.state.doc.textBetween(from, to, ' '), href: editor.getAttributes('link').href || '' });
  };
  const applyLink = ({ text, href }) => {
    const { from, to, text: old } = linking;
    setLinking(null);
    const ch = editor.chain().focus().setTextSelection({ from, to });
    if (text && text !== old) {
      // New or changed text: put it in with the link (keeping the formatting where the text starts).
      const marks = editor.state.doc.resolve(from).marks().filter((m) => m.type.name !== 'link').map((m) => m.toJSON());
      ch.insertContentAt({ from, to }, { type: 'text', text, marks: [...marks, { type: 'link', attrs: { href } }] }).run();
    } else {
      ch.extendMarkRange('link').setLink({ href }).run();
    }
  };
  const removeLink = () => {
    const { from, to } = linking;
    setLinking(null);
    editor.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').unsetLink().run();
  };
  // Popups give focus back to the message straight away when something is picked (the editor's own
  // focus() waits for the next frame, and a key pressed in between would be lost).
  const refocus = () => { try { editor.view.focus(); } catch { /* not mounted */ } };
  const B = ({ label, title, active, onClick, disabled, toggle = true }) => (
    <button type="button" className={`tb ${active ? 'on' : ''}`} title={title} aria-label={title} aria-pressed={toggle ? !!active : undefined}
      disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  return (
    <div className="compose-editor">
      <div className="toolbar compose-toolbar" role="toolbar" aria-label="Formatting">
        <B label={<UndoIcon />} title="Undo (Ctrl+Z)" toggle={false} disabled={!editor.can().undo()} onClick={() => c().undo().run()} />
        <B label={<UndoIcon redo />} title="Redo (Ctrl+Y)" toggle={false} disabled={!editor.can().redo()} onClick={() => c().redo().run()} />
        <span className="sep" />
        <select className="tb-select" aria-label="Font" title="Font" value={fontName(editor.getAttributes('textStyle').fontFamily)}
          onChange={(e) => { const stack = FONTS.find(([n]) => n === e.target.value)?.[1]; (stack ? c().setFontFamily(stack) : c().unsetFontFamily()).run(); }}>
          {FONTS.map(([n, stack]) => <option key={n} value={n} style={stack ? { fontFamily: stack } : undefined}>{n}</option>)}
          {fontName(editor.getAttributes('textStyle').fontFamily) === 'Other font' && <option value="Other font" disabled>Other font</option>}
        </select>
        <select className="tb-select" aria-label="Font size" title="Font size" value={sizeName(editor.getAttributes('textStyle').fontSize)}
          onChange={(e) => { const px = FONT_SIZES.find(([n]) => n === e.target.value)?.[1]; (px ? c().setFontSize(px) : c().unsetFontSize()).run(); }}>
          {FONT_SIZES.map(([n]) => <option key={n} value={n}>{n}</option>)}
          {sizeName(editor.getAttributes('textStyle').fontSize) === 'Other' && <option value="Other" disabled>Other size</option>}
        </select>
        <span className="sep" />
        <B label={<b>B</b>} title="Bold" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} />
        <B label={<i>I</i>} title="Italic" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} />
        <B label={<u>U</u>} title="Underline" active={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()} />
        <ColorPicker refocus={refocus} label="Text colour" kind="text" options={TEXT_COLORS} none="Automatic" current={editor.getAttributes('textStyle').color || null}
          icon={(shown) => <span className="color-a">A<span className="color-bar" style={{ background: shown || 'currentColor' }} /></span>}
          onPick={(color) => (color ? c().setColor(color).run() : c().unsetColor().run())} />
        <ColorPicker refocus={refocus} label="Highlight colour" kind="highlight" options={HIGHLIGHTS} none="None" current={editor.getAttributes('textStyle').backgroundColor || null}
          icon={(shown) => <span className="color-a hl"><span className="hl-pen" aria-hidden="true">🖍</span><span className="color-bar" style={{ background: shown || 'transparent' }} /></span>}
          onPick={(color) => (color ? c().setBackgroundColor(color).run() : c().unsetBackgroundColor().run())} />
        <span className="sep" />
        {(() => {
          // One button for alignment, showing the current one. With a picture selected it aligns the
          // picture; otherwise the paragraph.
          const pic = editor.isActive('image');
          const now = pic ? editor.getAttributes('image').align || 'left' : editor.isActive({ textAlign: 'center' }) ? 'center' : editor.isActive({ textAlign: 'right' }) ? 'right' : 'left';
          const names = { left: 'Align left', center: 'Centre', right: 'Align right' };
          return (
            <MenuButton refocus={refocus} label={pic ? 'Picture alignment' : 'Alignment'} icon={<AlignIcon to={now} />} items={['left', 'center', 'right'].map((al) => ({
              label: pic ? `${names[al]} (picture)` : names[al], icon: <AlignIcon to={al} />, checked: now === al, radio: true,
              onSelect: () => (pic ? c().updateAttributes('image', { align: al === 'left' ? null : al }) : al === 'left' ? c().unsetTextAlign() : c().setTextAlign(al)).run(),
            }))} />
          );
        })()}
        <B label="•" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} />
        <B label="1." title="Numbered list" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()} />
        <span className="sep" />
        <B label="🔗" title={editor.isActive('link') ? 'Edit link (Ctrl+K)' : 'Insert link (Ctrl+K)'} active={editor.isActive('link')} onClick={() => linkOpen.current()} />
        <B label="🖼" title="Insert picture" onClick={() => fileInput.current.click()} />
        <EmojiPicker keepFocus beforePick={refocus} onPick={(ch) => c().insertContent(ch).run()} />
        <TablePicker refocus={refocus} disabled={editor.isActive('table')} onPick={(rows, cols, withHeaderRow) => c().insertTable({ rows, cols, withHeaderRow }).run()} />
        <MenuButton refocus={refocus} end label="More formatting" icon={<span aria-hidden="true">⋮</span>} items={[
          { label: 'Strikethrough', icon: <s>S</s>, checked: editor.isActive('strike'), onSelect: () => c().toggleStrike().run() },
          { label: 'Quote', icon: '❝', checked: editor.isActive('blockquote'), onSelect: () => c().toggleBlockquote().run() },
          { label: 'Decrease indent (Ctrl+[)', icon: <IndentIcon out />, onSelect: () => c().outdent().run() },
          { label: 'Increase indent (Ctrl+])', icon: <IndentIcon />, onSelect: () => c().indent().run() },
          { label: 'Clear formatting', icon: 'Tx', onSelect: () => c().unsetAllMarks().clearNodes().run() },
        ]} />
        {editor.isActive('image') && (
          <span className="img-sizes" role="group" aria-label="Picture size">
            <span className="sep" />
            {IMAGE_SIZES.map(([w, name]) => (
              <B key={w} label={name} title={`${name} picture (${w}% of the message width)`} active={(editor.getAttributes('image').width || 100) === w}
                onClick={() => c().updateAttributes('image', { width: w === 100 ? null : w }).run()} />
            ))}
            {editablePicture(editor.getAttributes('image').src) && (
              <B label="✂ Crop / rotate" title="Crop or rotate picture" onClick={() => openEditor(editor)} />
            )}
          </span>
        )}
        {editor.isActive('table') && (
          <span className="img-sizes" role="group" aria-label="Table">
            <span className="sep" />
            <B label="+ Row" title="Add a row below" onClick={() => c().addRowAfter().run()} />
            <B label="− Row" title="Delete this row" onClick={() => c().deleteRow().run()} />
            <B label="+ Column" title="Add a column to the right" onClick={() => c().addColumnAfter().run()} />
            <B label="− Column" title="Delete this column" onClick={() => c().deleteColumn().run()} />
            <B label="Delete table" title="Delete table" onClick={() => c().deleteTable().run()} />
          </span>
        )}
        {uploading > 0 && <span className="muted small">Uploading picture…</span>}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="Picture file"
          onChange={(e) => { insertImages(e.target.files); e.target.value = ''; }} />
      </div>
      <EditorContent editor={editor} />
      {/* Outside the Compose form, so the editor's buttons never submit (send) the message. */}
      {linking && createPortal(<LinkDialog initial={linking} onApply={applyLink} onRemove={linking.href ? removeLink : null}
        onClose={() => { setLinking(null); editor.commands.focus(); }} />, document.body)}
      {editing && createPortal(<ImageEditor src={editing.src} alt={editing.alt} onClose={() => { setEditing(null); editor.commands.focus(); }} onDone={applyEdit} />, document.body)}
    </div>
  );
}

// Pictures inserted from Drive, or carried over from a forwarded message.
/** Escape anywhere in a toolbar popup (its button included) closes just the popup and returns to its button. */
/** Shift a just-opened popup sideways so it stays on screen (toolbars wrap on phones). */
function keepOnScreen(el) {
  if (!el) return;
  el.style.transform = '';
  const r = el.getBoundingClientRect();
  const room = document.documentElement.clientWidth - 8;
  const dx = r.right > room ? room - r.right : r.left < 8 ? 8 - r.left : 0;
  if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
}

/**
 * Enter, Space or Down on a toolbar popup's button opens it. The key is handled here (default
 * cancelled), so the same key press can't also activate the item that receives focus.
 */
const keyOpens = (open, setOpen) => (e) => {
  if (open || !['Enter', ' ', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  setOpen(true);
};

const escCloses = (open, setOpen, wrap) => (e) => {
  if (!open || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation(); // not the message window
  setOpen(false);
  wrap.current?.querySelector('button')?.focus();
};

// Text colours that read well on a white page (and in mail apps' dark modes).
const TEXT_COLORS = [
  ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#00796b', 'Teal'], ['#1a73e8', 'Blue'],
  ['#174ea6', 'Dark blue'], ['#8430ce', 'Purple'], ['#d01884', 'Pink'], ['#795548', 'Brown'], ['#5f6368', 'Grey'],
];
// Fonts: the same font lists the server keeps when quoting mail, so quoted fonts show by name.
// Each lists fallbacks for computers that don't have the font.
const FONTS = [
  ['Sans Serif', null], ['Georgia', 'Georgia, serif'], ['Times New Roman', "'Times New Roman', Times, serif"], ['Garamond', 'Garamond, Georgia, serif'],
  ['Courier New', "'Courier New', Courier, monospace"], ['Verdana', 'Verdana, sans-serif'], ['Tahoma', 'Tahoma, sans-serif'],
  ['Trebuchet MS', "'Trebuchet MS', sans-serif"], ['Calibri', 'Calibri, Arial, sans-serif'], ['Comic Sans MS', "'Comic Sans MS', cursive"],
];
const fontKey = (v) => String(v || '').replace(/['"\s]/g, '').toLowerCase();
const fontName = (v) => (!v ? 'Sans Serif' : FONTS.find(([, stack]) => stack && fontKey(stack) === fontKey(v))?.[0] || 'Other font');

const MAX_INDENT = 8, INDENT_PX = 40;
const clampIndent = (n) => Math.max(0, Math.min(MAX_INDENT, Math.round(n) || 0));

/**
 * Paragraph indent, 40px a step (up to 8), sent as a left margin that mail apps show.
 * In a list the same commands nest / un-nest the item. Ctrl+] / Ctrl+[ (Tab stays free for
 * moving out of the message with the keyboard).
 */
const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el) => {
            const d = Number(el.getAttribute('data-indent'));
            if (d) return clampIndent(d);
            const m = /^([\d.]+)px$/.exec(el.style.marginLeft || '');
            return m ? clampIndent(parseFloat(m[1]) / INDENT_PX) : 0;
          },
          renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * INDENT_PX}px` } : {}),
        },
      },
    }];
  },
  addCommands() {
    const change = (delta) => () => ({ state, tr, dispatch, commands, editor }) => {
      if (editor.isActive('listItem')) return delta > 0 ? commands.sinkListItem('listItem') : commands.liftListItem('listItem');
      let changed = false;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name !== 'paragraph') return true;
        const next = clampIndent((node.attrs.indent || 0) + delta);
        if (next !== (node.attrs.indent || 0)) {
          changed = true;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
        }
        return false;
      });
      return changed;
    };
    return { indent: change(1), outdent: change(-1) };
  },
  addKeyboardShortcuts() {
    return { 'Mod-]': () => this.editor.commands.indent(), 'Mod-[': () => this.editor.commands.outdent() };
  },
});

function IndentIcon({ out }) {
  return (
    <svg width="16" height="16" viewBox="0 0 18 16" aria-hidden="true" fill="currentColor">
      {[0, 1, 2, 3].map((i) => <rect key={i} x={i === 0 || i === 3 ? 2 : 8} y={2 + i * 3.5} width={i === 0 || i === 3 ? 14 : 8} height="1.8" rx=".9" />)}
      <path d={out ? 'M5.5 6.2 2.5 8.6l3 2.4z' : 'M2.5 6.2l3 2.4-3 2.4z'} />
    </svg>
  );
}

/**
 * A toolbar button with a small menu (alignment, more formatting). Enter / Space / Down open it,
 * the arrow keys move, Enter picks, Escape closes it and returns to the button. Choices that can
 * be on or off show as checked.
 */
function MenuButton({ label, icon, items, end, refocus }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef();
  const menu = useRef();
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    keepOnScreen(menu.current);
    const list = [...(menu.current?.querySelectorAll('[role^="menuitem"]') || [])];
    (list.find((el) => el.getAttribute('aria-checked') === 'true' && el.getAttribute('role') === 'menuitemradio') || list[0])?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const list = [...(menu.current?.querySelectorAll('[role^="menuitem"]') || [])];
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -99, End: 99 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    list[Math.max(0, Math.min(list.length - 1, (i < 0 ? (step > 0 ? -1 : list.length) : i) + step))]?.focus();
  };
  return (
    <span className="tb-menu" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>
        {icon}<span className="tb-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={`tb-menu-pop ${end ? 'end' : ''}`} role="menu" aria-label={label} ref={menu}>
          {items.map((it) => (
            <button type="button" key={it.label} role={it.radio ? 'menuitemradio' : it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined} aria-label={it.label} className={`tb-menu-item ${it.checked ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); refocus?.(); it.onSelect(); }}>
              <span className="tb-menu-icon" aria-hidden="true">{it.icon}</span>{it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function UndoIcon({ redo }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5.5 4 2.5 7l3 3" /><path d="M2.8 7H10a3.5 3.5 0 0 1 0 7H7.5" />
    </svg>
  );
}

/** Lines icon for the alignment buttons. */
function AlignIcon({ to }) {
  const x = (w) => (to === 'left' ? 2 : to === 'right' ? 16 - w : (18 - w) / 2);
  return (
    <svg width="16" height="16" viewBox="0 0 18 16" aria-hidden="true" fill="currentColor">
      {[14, 9, 14, 9].map((w, i) => <rect key={i} x={x(w)} y={2 + i * 3.5} width={w} height="1.8" rx=".9" />)}
    </svg>
  );
}

// Font sizes (as in most mail apps). "Normal" means no size of its own.
const FONT_SIZES = [['Small', '12px'], ['Normal', null], ['Large', '18px'], ['Huge', '24px']];
const sizeName = (v) => (!v ? 'Normal' : FONT_SIZES.find(([, px]) => px === String(v).replace(/\s/g, ''))?.[0] || 'Other');

// Highlights: light enough that text stays readable on them (and on a white page).
const HIGHLIGHTS = [
  ['#fef08a', 'Yellow'], ['#bbf7d0', 'Green'], ['#bfdbfe', 'Blue'], ['#fbcfe8', 'Pink'],
  ['#fed7aa', 'Orange'], ['#e9d5ff', 'Purple'], ['#e5e7eb', 'Grey'],
];
const toHex = (v) => {
  const m = String(v || '').match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return m ? `#${m.slice(1).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : String(v || '').toLowerCase();
};
/** "#abc", "abc", "#aabbcc" -> "#aabbcc"; anything else -> null. */
const normHex = (v) => {
  const m = String(v || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Custom colours you used recently, per palette, in this browser.
const recentKey = (kind) => `nw.recentColors.${kind}`;
const loadRecent = (kind) => { try { return (JSON.parse(localStorage.getItem(recentKey(kind))) || []).map(normHex).filter(Boolean).slice(0, 6); } catch { return []; } };
const saveRecent = (kind, hex, palette) => {
  if (palette.some(([v]) => v === hex)) return;
  try { localStorage.setItem(recentKey(kind), JSON.stringify([hex, ...loadRecent(kind).filter((h) => h !== hex)].slice(0, 6))); } catch { /* private window */ }
};

const sameColor = (a, b) => !!a && toHex(a) === toHex(b);

/**
 * Text or highlight colour: the button shows the colour at the cursor; the palette sets it on the
 * selection (or on what you type next). The first choice ("Automatic" / "None") removes it.
 * Arrow keys move, Enter picks, Escape closes.
 */
function ColorPicker({ label, kind, options: colors, none, icon, current, onPick, refocus }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState(() => loadRecent(kind));
  const [custom, setCustom] = useState('');
  const wrap = useRef();
  const list = useRef();
  const options = [[null, none], ...colors, ...recent.filter((h) => !colors.some(([v]) => v === h)).map((h) => [h, `Custom ${h}`])];
  const chosen = normHex(custom);
  // Readability: text on a white page, or dark text on the highlight.
  const warning = chosen && (kind === 'text'
    ? (contrast(chosen, '#ffffff') < 3 ? 'Light colours are hard to read on a white page.' : '')
    : (contrast('#1f1f1f', chosen) < 4.5 ? 'Dark highlights make the text on them hard to read.' : ''));
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    const i = Math.max(0, options.findIndex(([v]) => (v ? sameColor(current, v) : !current)));
    keepOnScreen(list.current?.closest('.color-pop'));
    list.current?.querySelectorAll('button')[i]?.focus();
    setRecent(loadRecent(kind));
    setCustom(current ? toHex(current) : '');
    return () => document.removeEventListener('mousedown', away);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = (v) => { setOpen(false); refocus?.(); onPick(v); };
  const applyCustom = () => { if (!chosen) return; saveRecent(kind, chosen, colors); pick(chosen); };
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const buttons = [...(list.current?.querySelectorAll('button') || [])];
    let i = buttons.indexOf(document.activeElement);
    if (i < 0) {
      if (document.activeElement !== wrap.current?.querySelector('button')) return; // typing in the custom colour box
      i = Math.max(0, options.findIndex(([v]) => (v ? sameColor(current, v) : !current))); // still on the toolbar button
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -99, End: 99 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + step))].focus();
  };
  return (
    <span className="color-picker" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>
        {icon(current)}
      </button>
      {open && (
        <div className="color-pop" role="dialog" aria-label={label}>
          <div className="color-list" ref={list} role="listbox" aria-label="Colours">
            {options.map(([v, name]) => {
              const on = v ? sameColor(current, v) : !current;
              return (
                <button type="button" key={name} role="option" aria-selected={on} aria-label={name} title={name}
                  className={`swatch ${v ? '' : 'auto'} ${on ? 'on' : ''}`} style={v ? { background: v } : undefined}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => pick(v)} />
              );
            })}
          </div>
          <div className="color-custom" role="group" aria-label="Custom colour">
            <input type="color" aria-label="Choose a custom colour" value={chosen || (kind === 'text' ? '#1f1f1f' : '#fef08a')}
              onChange={(e) => setCustom(e.target.value)} />
            <input type="text" aria-label="Colour code" placeholder="#1a73e8" maxLength={7} spellCheck={false} value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyCustom(); } }} />
            <button type="button" className="btn small" disabled={!chosen} onClick={applyCustom}>Apply</button>
          </div>
          {custom && (
            <div className="color-sample" aria-live="polite">
              {chosen
                ? <span style={kind === 'text' ? { color: chosen } : { background: chosen, color: '#1f1f1f' }}>Sample text</span>
                : <span className="muted">Enter a colour code like #1a73e8</span>}
              {warning && <div className="color-warn">{warning}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

const PICK_MAX = 8;

/**
 * "Insert table": a grid to choose the size (hover, or arrow keys and Enter), with a header row
 * option. Not offered inside a table, so tables aren't nested.
 */
function TablePicker({ onPick, disabled, refocus }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState([2, 3]); // [rows, cols] highlighted
  const [header, setHeader] = useState(true);
  const wrap = useRef();
  const grid = useRef();
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    keepOnScreen(grid.current?.closest('.table-picker-pop'));
    grid.current?.querySelector('[tabindex="0"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Close first, then insert, so the cursor lands in the new table's first cell.
  const pick = (r, c) => { setOpen(false); refocus?.(); requestAnimationFrame(() => onPick(r, c, header)); };
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const [r, c] = at;
    const next = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c] }[e.key];
    // Enter/Space insert the highlighted size (not whichever cell the browser would click).
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[role="grid"]')) { e.preventDefault(); pick(r, c); return; }
    if (!next) return;
    e.preventDefault();
    const n = next.map((v) => Math.max(1, Math.min(PICK_MAX, v)));
    setAt(n);
    grid.current?.querySelector(`[data-cell="${n[0]}-${n[1]}"]`)?.focus(); // every cell is already rendered
  };
  return (
    <span className="table-picker" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={disabled ? 'Insert table (not inside another table)' : 'Insert table'} aria-label="Insert table"
        aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>▦</button>
      {open && (
        <div className="table-picker-pop" role="dialog" aria-label="Table size">
          <div className="table-picker-grid" ref={grid} role="grid" aria-label="Choose rows and columns">
            {Array.from({ length: PICK_MAX }, (_, i) => (
              <div role="row" key={i}>
                {Array.from({ length: PICK_MAX }, (_, j) => {
                  const r = i + 1, c = j + 1;
                  return (
                    <button type="button" role="gridcell" key={j} data-cell={`${r}-${c}`} tabIndex={r === at[0] && c === at[1] ? 0 : -1}
                      className={r <= at[0] && c <= at[1] ? 'on' : ''} aria-label={`${r} by ${c} table`}
                      onMouseDown={(e) => e.preventDefault()} onMouseEnter={(e) => e.currentTarget.focus()} onFocus={() => setAt([r, c])} onClick={() => pick(r, c)} />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="table-picker-foot">
            <span aria-live="polite">{at[0]} × {at[1]}</span>
            <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Header row</label>
          </div>
        </div>
      )}
    </span>
  );
}

/** Insert or change a link: the text shown, and a web or email address. */
function LinkDialog({ initial, onApply, onRemove, onClose }) {
  const startEmail = /^mailto:/i.test(initial.href);
  const [text, setText] = useState(initial.text);
  const [kind, setKind] = useState(startEmail ? 'email' : 'web');
  const [address, setAddress] = useState(startEmail ? initial.href.replace(/^mailto:/i, '') : initial.href);
  const href = linkHref(kind, address);
  const bad = address.trim() && !href;
  // stopPropagation: this dialog is opened from inside the message form, which must not see the submit.
  const submit = (e) => { e.preventDefault(); e.stopPropagation(); if (href) onApply({ text: text.trim() ? text : (initial.text || address.trim()), href }); };
  return (
    <Modal title={initial.href ? 'Edit link' : 'Insert link'} onClose={onClose} footer={<>
      {onRemove && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={onRemove}>Remove link</button>}
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="link-form" className="btn primary" disabled={!href}>{initial.href ? 'Save' : 'Insert'}</button>
    </>}>
      <form id="link-form" className="stack" onSubmit={submit}>
        <label className="field"><span>Text to display</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave empty to show the address" autoFocus={!initial.text} /></label>
        <div className="row" role="radiogroup" aria-label="Link to">
          <label className="check"><input type="radio" name="link-kind" checked={kind === 'web'} onChange={() => setKind('web')} /> Web address</label>
          <label className="check"><input type="radio" name="link-kind" checked={kind === 'email'} onChange={() => setKind('email')} /> Email address</label>
        </div>
        <label className="field"><span>{kind === 'web' ? 'Web address' : 'Email address'}</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} autoFocus={!!initial.text} inputMode={kind === 'email' ? 'email' : 'url'}
            placeholder={kind === 'web' ? 'example.com/page' : 'name@company.com'} aria-invalid={bad || undefined} aria-describedby="link-help" spellCheck={false} /></label>
        <p id="link-help" className={`small ${bad ? 'error' : 'muted'}`} aria-live="polite">
          {bad ? (kind === 'web' ? 'Enter a web address, like example.com or https://example.com/page.' : 'Enter an email address, like name@company.com.')
            : href && kind === 'web' ? <a href={href} target="_blank" rel="noopener noreferrer">Test this link</a> : '\u00a0'}
        </p>
      </form>
    </Modal>
  );
}

const editablePicture = (src) => /^\/api\/files\/[^/]+\/raw$|^\/api\/mail\/messages\/\d+\/pictures\/\d+\?folder=[^&]+$/.test(src || '');
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const ASPECT_NAMES = { free: 'Free', square: 'Square', '4:3': '4:3', '16:9': '16:9' };

/**
 * Crop and rotate a picture. Works on the real pixels: the result is saved to Drive as
 * "name (edited).jpg/png" and replaces the picture in the message.
 */
function ImageEditor({ src, alt, onClose, onDone }) {
  const toast = useToast();
  const [source, setSource] = useState(null); // { img, mime }
  const [error, setError] = useState('');
  const [rot, setRot] = useState(0);
  const [aspect, setAspect] = useState('free');
  const [rect, setRect] = useState(FULL);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef();
  const stageRef = useRef();

  useEffect(() => {
    let url = null, gone = false;
    (async () => {
      try {
        const res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Could not load the picture');
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        const img = new window.Image();
        img.src = url;
        await img.decode();
        if (!gone) setSource({ img, mime: blob.type });
      } catch (e) { if (!gone) setError(e.message || 'Could not load the picture'); }
    })();
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [src]);

  const size = source ? rotatedSize(source.img.naturalWidth, source.img.naturalHeight, rot) : { w: 1, h: 1 };

  // Draw the rotated picture at full resolution; the preview is the same canvas scaled down by CSS.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!source || !cv) return;
    drawRotated(cv, source.img, rot);
  }, [source, rot]);

  const rotate = (by) => {
    const next = (rot + by + 360) % 360;
    setRot(next);
    const s = rotatedSize(source.img.naturalWidth, source.img.naturalHeight, next);
    setRect(fitAspect(ASPECTS[aspect], s.w, s.h));
  };
  const chooseAspect = (a) => { setAspect(a); setRect(fitAspect(ASPECTS[a], size.w, size.h)); };

  // Drag the frame to move it, or a handle to resize it. Movements are converted to fractions of the preview.
  const startDrag = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    const box = stageRef.current.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, r: rect };
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / box.width, dy = (ev.clientY - start.y) / box.height;
      setRect(handle ? resizeRect(start.r, handle, dx, dy, ASPECTS[aspect], size.w, size.h) : moveRect(start.r, dx, dy));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  // Arrows move the frame; Shift+arrows resize it from the bottom-right corner.
  const onKey = (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const [dx, dy] = d.map((v) => v * 0.01);
    setRect((r) => (e.shiftKey ? resizeRect(r, 'se', dx, dy, ASPECTS[aspect], size.w, size.h) : moveRect(r, dx, dy)));
  };

  const changed = rot !== 0 || rect.x > 1e-6 || rect.y > 1e-6 || rect.w < 1 - 1e-6 || rect.h < 1 - 1e-6;
  const pixels = source ? toPixels(rect, size.w, size.h) : null;

  async function apply() {
    if (!changed) return onClose();
    setBusy(true);
    try {
      const full = document.createElement('canvas');
      drawRotated(full, source.img, rot);
      const out = document.createElement('canvas');
      out.width = pixels.sw;
      out.height = pixels.sh;
      const ctx = out.getContext('2d');
      const kind = outputType(source.mime);
      if (kind.type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); } // JPEG has no transparency
      ctx.drawImage(full, pixels.sx, pixels.sy, pixels.sw, pixels.sh, 0, 0, pixels.sw, pixels.sh);
      const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the picture'))), kind.type, kind.quality));
      const rec = await uploadFile(new File([blob], editedName(alt, kind.ext), { type: kind.type }), null);
      onDone({ src: `/api/files/${rec.id}/raw`, alt: rec.name });
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  const pct = (v) => `${v * 100}%`;
  return (
    <Modal title="Crop and rotate picture" wide onClose={busy ? () => {} : onClose} footer={<>
      {pixels && <span className="muted small crop-size" aria-live="polite">{pixels.sw} × {pixels.sh} px</span>}
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn primary" onClick={apply} disabled={!source || busy}>{busy ? 'Saving…' : 'Apply'}</button>
    </>}>
      {error ? <p className="error">{error}</p> : !source ? <p className="muted">Loading picture…</p> : (
        <>
          <div className="toolbar crop-tools" role="toolbar" aria-label="Picture tools">
            <button type="button" className="btn" onClick={() => rotate(-90)} aria-label="Rotate left">⟲ Rotate left</button>
            <button type="button" className="btn" onClick={() => rotate(90)} aria-label="Rotate right">⟳ Rotate right</button>
            <span className="sep" />
            <span role="group" aria-label="Crop shape" className="crop-aspects">
              {Object.keys(ASPECTS).map((a) => (
                <button type="button" key={a} className={`btn ${aspect === a ? 'on' : ''}`} aria-pressed={aspect === a} onClick={() => chooseAspect(a)}>{ASPECT_NAMES[a]}</button>
              ))}
            </span>
            <button type="button" className="btn" onClick={() => setRect(fitAspect(ASPECTS[aspect], size.w, size.h))}>Reset crop</button>
          </div>
          <div className="crop-area">
            <div className="crop-stage" ref={stageRef}>
              <canvas ref={canvasRef} aria-label="Picture preview" role="img" />
              <div className="crop-frame" tabIndex={0} role="group" aria-label="Crop area. Use the arrow keys to move it, Shift and the arrow keys to resize it."
                style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                onPointerDown={(e) => startDrag(e, null)} onKeyDown={onKey}>
                {HANDLES.map((h) => <span key={h} className={`crop-handle ${h}`} data-handle={h} onPointerDown={(e) => startDrag(e, h)} />)}
              </div>
            </div>
          </div>
          <p className="muted small">Drag the frame or its edges. Applying saves a new copy to your Drive; the original stays as it was, and Ctrl+Z in the message puts it back.</p>
        </>
      )}
    </Modal>
  );
}

/** Draw img into canvas cv rotated by deg (multiple of 90), resizing the canvas to fit. */
function drawRotated(cv, img, deg) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const s = rotatedSize(W, H, deg);
  cv.width = s.w;
  cv.height = s.h;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(s.w / 2, s.h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -W / 2, -H / 2);
  ctx.restore();
}

function SignatureDialog({ signatures, onClose, onSaved }) {
  const toast = useToast();
  const [address, setAddress] = useState(signatures[0]?.address);
  const current = signatures.find((x) => x.address === address) || { html: '', on_new: true, on_reply: true };
  const [html, setHtml] = useState(current.html);
  const [onNew, setOnNew] = useState(current.on_new);
  const [onReply, setOnReply] = useState(current.on_reply);
  const pick = (a) => {
    const sg = signatures.find((x) => x.address === a);
    setAddress(a); setHtml(sg.html); setOnNew(sg.on_new); setOnReply(sg.on_reply);
  };
  return (
    <Modal wide title="Signatures" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return; // a dialog opened from inside (see Compose's send)
        try {
          const r = await put(`/mail/signatures/${encodeURIComponent(address)}`, { html, on_new: onNew, on_reply: onReply });
          toast(`Signature for ${address} saved`);
          onSaved(signatures.map((x) => (x.address === address ? { ...x, ...r, company: r.company } : x)));
        } catch (err) { toast(err.message, 'error'); }
      }}>
        {signatures.length > 1 && (
          <div className="tabs" role="tablist" aria-label="Sending address">
            {signatures.map((x) => (
              <button type="button" key={x.address} role="tab" aria-selected={x.address === address} className={x.address === address ? 'on' : ''} onClick={() => pick(x.address)}>{x.address}</button>
            ))}
          </div>
        )}
        {current.company === 'always' ? (
          <div className="stack-tight">
            <p className="small" style={{ margin: 0 }}>Your company uses one signature for everyone, filled in with your details (your job title and phone are in Settings → About you):</p>
            <div className="signature-preview card" aria-label="Company signature" dangerouslySetInnerHTML={{ __html: current.html }} />
          </div>
        ) : <>
          {current.company === 'default' && <p className="small" style={{ margin: 0 }}>This is your company’s signature, filled in with your details. Change it to write your own.</p>}
          <RichBody key={`${address}-${current.company || 'own'}`} initialHtml={current.html} label="Signature" placeholder="Your name, title, company, phone…" onChange={(h) => setHtml(h)} />
          {!current.company && current.company_mode === 'default' && current.html && (
            <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={async () => {
              try { const r = await del(`/mail/signatures/${encodeURIComponent(address)}`); onSaved(signatures.map((x) => (x.address === address ? { ...x, ...r, company: r.company } : x))); toast('Using the company signature again'); onClose(); } catch (err) { toast(err.message, 'error'); }
            }}>Use the company signature instead</button>
          )}
        </>}
        <label className="check"><input type="checkbox" checked={onNew} onChange={(e) => setOnNew(e.target.checked)} /> Add to new messages</label>
        <label className="check"><input type="checkbox" checked={onReply} onChange={(e) => setOnReply(e.target.checked)} /> Add to replies and forwards (above the quoted message)</label>
        <p className="muted small" style={{ margin: 0 }}>Each address you can send from has its own signature. Changing “From” while writing switches the signature.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button>{current.company !== 'always' && <button className="btn primary">Save</button>}</div>
      </form>
    </Modal>
  );
}

/** The signature lives in its own block so switching "From" can find and replace it. */
const SignatureBlock = TiptapNode.create({
  name: 'signature',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() { return [{ tag: 'div[data-signature]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-signature': '', class: 'signature' }), 0]; },
});

function signatureBlock(signatures, address, kind) {
  const sg = signatures.find((x) => x.address === address);
  if (!sg?.html || (kind === 'new' ? !sg.on_new : !sg.on_reply)) return '';
  return `<div data-signature=""><p>-- </p>${sg.html}</div>`;
}

/** Replace the signature block (or add one: at the end of a new message, below the first line of a reply). */
function swapSignature(editor, html) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'signature') { found = { from: pos, to: pos + node.nodeSize }; return false; }
    return true;
  });
  if (found) {
    if (html) editor.chain().insertContentAt(found, html).run();
    else editor.chain().deleteRange(found).run();
  } else if (html) {
    const first = editor.state.doc.firstChild;
    const isReply = editor.getHTML().includes('<blockquote');
    editor.chain().insertContentAt(isReply && first ? first.nodeSize : editor.state.doc.content.size, html).run();
  }
}

/** Picture sizes as a share of the message width; stored on the picture so mail apps show the same size. */
const IMAGE_SIZES = [[25, 'Small'], [50, 'Medium'], [75, 'Large'], [100, 'Full width']];
const MIN_WIDTH = 10;
const SNAP = [25, 50, 75, 100];
const clampWidth = (v) => Math.max(MIN_WIDTH, Math.min(100, Math.round(v)));

/**
 * Pictures with a size as a share of the message width (10-100%), stored on the picture so mail
 * apps show the same size. In the editor a selected picture gets a corner handle: drag it (snaps
 * to 25/50/75/100% when close), or focus it and use the arrow keys (Shift for 1% steps).
 */
const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const v = Number(el.getAttribute('data-width') || String(el.style?.width || '').replace('%', ''));
          return Number.isFinite(v) && v >= MIN_WIDTH && v < 100 ? Math.round(v) : null;
        },
        // The width attribute plus inline style work across Gmail, Outlook and phone mail apps;
        // max-width keeps pictures inside narrow screens.
        renderHTML: (attrs) => (attrs.width
          ? { 'data-width': attrs.width, width: `${attrs.width}%`, style: `width:${attrs.width}%; max-width:100%; height:auto` }
          : { style: 'max-width:100%; height:auto' }),
      },
      // Centred or right-aligned picture (left is normal). Margins in the message; the email also
      // wraps it in an aligned block for Outlook (see emailHtml).
      align: {
        default: null,
        parseHTML: (el) => (['center', 'right'].includes(el.getAttribute('data-align')) ? el.getAttribute('data-align') : null),
        renderHTML: (attrs) => (attrs.align === 'center' ? { 'data-align': 'center', style: 'display:block; margin-left:auto; margin-right:auto' }
          : attrs.align === 'right' ? { 'data-align': 'right', style: 'display:block; margin-left:auto' } : {}),
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'img-wrap';
      const img = document.createElement('img');
      const handle = document.createElement('span');
      handle.className = 'img-handle';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', 'Picture width');
      handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
      handle.setAttribute('aria-valuemax', '100');
      const label = document.createElement('span');
      label.className = 'img-size-label';
      dom.append(img, handle, label);

      // pct = null: no size chosen, so the picture shows at its natural size (never wider than the message).
      const show = (pct) => {
        dom.style.width = pct ? `${pct}%` : '';
        dom.classList.toggle('natural', !pct);
        const now = pct || shownPct();
        handle.setAttribute('aria-valuenow', String(now));
        handle.setAttribute('aria-valuetext', `${now}% of the message width`);
        label.textContent = `${now}%`;
      };
      const shownPct = () => {
        const full = contentWidth();
        return full > 0 ? clampWidth((dom.getBoundingClientRect().width / full) * 100) : 100;
      };
      const render = (n) => {
        img.src = n.attrs.src;
        img.alt = n.attrs.alt || '';
        if (n.attrs.width) dom.setAttribute('data-width', String(n.attrs.width)); else dom.removeAttribute('data-width');
        if (n.attrs.align) dom.setAttribute('data-align', n.attrs.align); else dom.removeAttribute('data-align');
        show(n.attrs.width || null);
      };
      img.addEventListener('load', () => { if (!current.attrs.width) show(null); }); // natural size known now
      img.addEventListener('dblclick', (e) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        e.preventDefault();
        editor.commands.setNodeSelection(pos);
        editor.emit('editPicture');
      });
      const commit = (pct) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        const width = pct >= 100 ? null : pct;
        if ((current.attrs.width || null) === width) return show(width);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width }));
      };
      const contentWidth = () => {
        // While the editor is still being set up (a draft or forward that opens with a picture),
        // there is nothing to measure yet; the picture's load event measures again.
        let el;
        try { el = editor.view.dom; } catch { return 0; }
        if (!el?.isConnected) return 0;
        const cs = getComputedStyle(el);
        return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      };

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        dom.classList.add('resizing');
        const startX = e.clientX;
        const startW = dom.getBoundingClientRect().width;
        const full = contentWidth();
        let pct = current.attrs.width || shownPct();
        const move = (ev) => {
          pct = clampWidth(((startW + ev.clientX - startX) / full) * 100);
          const near = SNAP.find((s) => Math.abs(s - pct) <= 2);
          if (near) pct = near;
          show(pct);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          dom.classList.remove('resizing');
          commit(pct);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 1 : 5;
        const now = current.attrs.width || shownPct();
        const next = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: MIN_WIDTH, End: 100 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        commit(clampWidth(next));
      });

      render(node);
      return {
        dom,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          render(n);
          return true;
        },
        selectNode() { dom.classList.add('ProseMirror-selectednode'); },
        deselectNode() { dom.classList.remove('ProseMirror-selectednode'); },
        // Let the handle have its own mouse/keyboard events instead of the editor.
        stopEvent: (e) => e.target === handle,
        ignoreMutation: () => true,
      };
    };
  },
});

const UNDO_SECONDS = 5;

/** A label's coloured chip, with a × to take it off when `onRemove` is given. */
function LabelChip({ label, onRemove }) {
  if (!label) return null;
  return (
    <span className="label-chip" style={{ '--c': label.color }}>
      {label.name}
      {onRemove && <button type="button" aria-label={`Take off ${label.name}`} onClick={onRemove}>×</button>}
    </span>
  );
}

function LabelGlyph() {
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.6 5.8A2 2 0 0 0 16 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 1.6-.8L22 12l-4.4-6.2zM16 17H5V7h11l3.5 5L16 17z" /></svg>;
}

/** Make a label, or change one's name and colour. */
function LabelDialog({ label, colors, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(label.name || '');
  const [color, setColor] = useState(label.color || colors[0] || '#1a73e8');
  async function save(e) {
    e.preventDefault();
    try { if (label.id) await api('PATCH', `/mail/labels/${label.id}`, { name, color }); else await post('/mail/labels', { name, color }); toast(label.id ? 'Label changed' : `Label “${name.trim()}” made`); onSaved(); }
    catch (err) { toast(err.message, 'error'); }
  }
  return (
    <Modal title={label.id ? 'Edit label' : 'New label'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="label-form" className="btn primary" disabled={!name.trim()}>{label.id ? 'Save' : 'Create'}</button></>}>
      <form id="label-form" className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <div className="label-colors" role="radiogroup" aria-label="Colour">
          {colors.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={color === c ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        {name.trim() && <div><LabelChip label={{ name: name.trim(), color }} /></div>}
      </form>
    </Modal>
  );
}

/** When snoozed mail can come back: later today (if there's time), tomorrow, the weekend, next week. */
export function snoozeChoices(now = new Date()) {
  const at = (days, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0).getTime();
  const out = [];
  const later = new Date(now.getTime() + 3 * 36e5); later.setMinutes(0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() <= 20) out.push(['Later today', later.getTime()]);
  out.push(['Tomorrow', at(1, 8)]);
  const day = now.getDay();
  if (day >= 1 && day <= 4) out.push(['This weekend', at(6 - day, 8)]);
  out.push(['Next week', at(((8 - day) % 7) || 7, 8)]);
  return out;
}

function SnoozeMenu({ onPick, onCustom, small }) {
  return (
    <Menu align="left" trigger={(p) => (small
      ? <button type="button" className="btn small" {...p}>Snooze</button>
      : <button type="button" className="icon-btn" aria-label="Snooze" title="Snooze" {...p}><Icon name="clock" /></button>)}
      items={[...snoozeChoices().map(([label, at]) => ({ label: `${label} · ${whenText(at)}`, onClick: () => onPick(at) })), '-', { label: 'Pick date and time…', icon: 'calendar', onClick: onCustom }]} />
  );
}


/** Messages waiting to be sent, with Send now and Don't send (back to Drafts). */
function ScheduledDialog({ list, onClose, onChanged }) {
  const toast = useToast();
  const act = (fn, done) => async () => { try { await fn(); toast(done); onChanged(); } catch (e) { toast(e.message, 'error'); onChanged(); } };
  return (
    <Modal wide title="Scheduled" onClose={onClose}>
      {!list.length ? <p className="muted">Nothing is waiting to be sent.</p> : (
        <ul className="scheduled-list">
          {list.map((m) => (
            <li key={m.id}>
              <div className="grow">
                <strong>{m.subject || '(no subject)'}</strong>
                <span className="muted small"> to {m.recipients.join(', ')}</span>
                <div className={`small ${m.status === 'failed' ? 'error' : 'muted'}`}>{m.status === 'failed' ? `Not sent: ${m.error}` : `Sends ${whenText(m.send_at)}`}</div>
              </div>
              <button type="button" className="btn small" onClick={act(() => post(`/mail/scheduled/${m.id}/send`), 'Sent')}>Send now</button>
              <button type="button" className="btn small" onClick={act(() => del(`/mail/scheduled/${m.id}`), 'Not sent: it’s back in Drafts')}>Don’t send</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Your templates: rename, change the subject, or delete (the text is changed by saving a message as a template again). */
function TemplatesDialog({ templates, onClose, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  return (
    <Modal title="Templates" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <ul className="rule-list">
        {templates.map((t) => (
          <li key={t.id}>
            {editing?.id === t.id ? (
              <form className="stack grow" onSubmit={async (e) => { e.preventDefault(); try { await api('PATCH', `/mail/templates/${t.id}`, { name: editing.name, subject: editing.subject }); setEditing(null); onChanged(); toast('Template saved'); } catch (err) { toast(err.message, 'error'); } }}>
                <label className="field"><span>Name</span><input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
                <label className="field"><span>Subject</span><input value={editing.subject || ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></label>
                <div className="row"><button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button><button className="btn small primary">Save</button></div>
              </form>
            ) : <>
              <span className="grow"><strong>{t.name}</strong>{t.subject && <span className="muted small"> · {t.subject}</span>}</span>
              <button type="button" className="icon-btn" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}><Icon name="edit" size={16} /></button>
              <button type="button" className="icon-btn" aria-label={`Delete ${t.name}`} onClick={async () => { await del(`/mail/templates/${t.id}`); onChanged(); toast('Template deleted'); }}><Icon name="trash" size={16} /></button>
            </>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** In a shared mailbox: who answers this message (one of the mailbox's people, who is told), and whether it's done. */
function AssignBar({ m, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  useEffect(() => { get('/mail/members').then(setMembers).catch(() => {}); }, []);
  const save = async (change, msg) => {
    try { const r = await post('/mail/assign', { message_id: m.messageId, subject: m.subject, ...change }); onChanged({ assignee: r.assignee, done: r.done }); if (msg) toast(msg); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="row mail-assign" role="group" aria-label="Who answers this">
      <label className="row small">Given to
        <select aria-label="Given to" value={m.assignee?.id || ''} onChange={(e) => { const id = e.target.value || null; const who = members.find((x) => x.id === id); save({ assignee_id: id }, id ? `Given to ${id === user.id ? 'you' : who?.name}` : 'Given to nobody'); }}>
          <option value="">Nobody</option>
          {members.map((x) => <option key={x.id} value={x.id}>{x.id === user.id ? `${x.name} (you)` : x.name}</option>)}
        </select>
      </label>
      {m.assignee?.id !== user.id && <button type="button" className="link-btn small" onClick={() => save({ assignee_id: user.id }, 'Given to you')}>Take it</button>}
      <span className="grow" />
      <button type="button" className={`btn small ${m.done ? '' : 'primary'}`} aria-pressed={!!m.done} onClick={() => save({ done: !m.done }, m.done ? 'Open again' : 'Marked done')}>{m.done ? '✓ Done · reopen' : 'Mark done'}</button>
    </div>
  );
}

/** Internal notes on a shared mailbox's message: for its people only, never sent to whoever wrote in. */
function InternalNotes({ messageId, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState('');
  const load = useCallback(() => get(`/mail/notes?message_id=${encodeURIComponent(messageId)}`).then(setNotes).catch(() => {}), [messageId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((e) => { if (e.type === 'mail-notes' && e.message_id === messageId) load(); }), [load, messageId]);
  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try { setNotes(await post('/mail/notes', { message_id: messageId, body: text.trim() })); setText(''); onChanged?.(); } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <section className="mail-notes" aria-label="Internal notes">
      <div className="small"><strong>Internal notes</strong> <span className="muted">· only people using this mailbox see these</span></div>
      {notes.length > 0 && (
        <ul className="plain-list">
          {notes.map((n) => (
            <li key={n.id} className="mail-note-item"><div className="row small"><strong className="grow">{n.user_name || 'Someone'}</strong><span className="muted">{formatDate(n.created_at)}</span>
              {n.user_id === user.id && <button type="button" className="icon-btn" aria-label="Delete note" onClick={async () => { try { setNotes(await del(`/mail/notes/${n.id}`)); onChanged?.(); } catch (err) { toast(err.message, 'error'); } }}><Icon name="close" size={14} /></button>}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div></li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={add}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} aria-label="Add an internal note" placeholder="Add a note for the team (not sent)" />
        <button className="btn small" disabled={!text.trim()}>Add note</button>
      </form>
    </section>
  );
}

/**
 * In Sent: whether a message was delivered to each recipient (from the mail server's log): ✓ Delivered,
 * waiting to retry or bounced, with what the receiving server said. Says nothing when it isn't in the log.
 */
function DeliveryStatus({ messageId }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    get(`/mail/delivery?message_id=${encodeURIComponent(messageId)}`).then((r) => { if (live) setD(r); }).catch(() => {});
    return () => { live = false; };
  }, [messageId]);
  if (!d?.recipients?.length) return null;
  const LABEL = { delivered: 'Delivered', waiting: 'Waiting to retry', bounced: 'Not delivered', refused: 'Refused' };
  const when = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const all = d.recipients.every((r) => r.status === 'delivered');
  return (
    <details className={`delivery ${all ? 'ok' : 'attention'}`} open={!all} aria-label="Delivery">
      <summary>{all ? `✓ Delivered to ${d.recipients.length === 1 ? d.recipients[0].to : `all ${d.recipients.length} recipients`}` : `Delivery: ${d.recipients.filter((r) => r.status !== 'delivered').length} not delivered yet`}</summary>
      <ul>
        {d.recipients.map((r) => (
          <li key={r.to}>
            <span className={`pill ${r.status === 'delivered' ? 'ok' : r.status === 'waiting' ? 'warn' : 'ext'}`}>{LABEL[r.status] || r.status}</span> {r.to}
            {r.reached && <span className="muted small"> (reached {r.reached})</span>}
            <span className="muted small"> · {when(r.at)}{r.tries > 1 ? ` · ${r.tries} tries` : ''}</span>
            {r.status !== 'delivered' && r.response && <div className="muted small">{r.response}{r.status === 'waiting' ? ' — the mail server keeps trying for up to 5 days.' : ''}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}
