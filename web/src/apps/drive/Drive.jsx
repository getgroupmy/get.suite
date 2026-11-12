import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { get, post, patch, del, put, uploadFile, uploadVersion, onLive, formatBytes, formatDate } from '../../api.js';
const PdfSignDialog = lazy(() => import('./PdfSign.jsx')); // pdf.js only when it's used
const PdfOrganizeDialog = lazy(() => import('./PdfOrganize.jsx'));
import { BUILT_IN } from './templates.js';
import Icon, { fileIcon } from '../../components/Icon.jsx';
import { Menu, Modal, PromptModal, ConfirmModal, Empty, useToast, Avatar, useDataCheck } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { ApprovalsView, RequestApproval } from './Approvals.jsx';
import { SignaturesView, SendForSignature } from '../docs/Signatures.jsx';
import { CommentsPanel, useComments, NewCount } from '../comments.jsx';
import OfficePreview from '../OfficePreview.jsx';
import ZipContents from '../ZipContents.jsx';
import EmlContents from '../EmlContents.jsx';
import ScanDialog from './ScanDialog.jsx';
import SharedInDialog from './SharedInDialog.jsx';
import { readShared } from '../../shareinbox.js';
import { openUrl } from '../../components/DrivePicker.jsx';
import { DRAFT_KEY } from '../docs/blocks.js';
import { useMailStatus } from '../../mailStatus.js';
import { sortFiles, isPicture } from './drivesort.js';

function useDriveRoute() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const parts = pathname.replace(/^\/drive\/?/, '').split('/');
  if (parts[0] === 'folder' && parts[1]) return { view: 'mine', folderId: parts[1] };
  if (['drives', 'shared', 'recent', 'starred', 'trash', 'approvals', 'signatures'].includes(parts[0])) return { view: parts[0] };
  if (parts[0] === 'label' && parts[1]) return { view: 'label', label: decodeURIComponent(parts[1]) };
  if (parts[0] === 'search') return { view: 'search', q: params.get('q') || '', filters: Object.fromEntries(FILTERS.map(([k]) => [k, params.get(k) || ''])) };
  return { view: 'mine', folderId: null };
}

/** "Viewers can't download, print or copy" is on and you can only view or comment. */
export const viewOnly = (f) => !!f?.no_download && !['editor', 'owner'].includes(f.role);

export function openPath(f) {
  if (f.kind === 'folder') return `/drive/folder/${f.id}`;
  if (f.kind === 'doc') return `/docs/${f.id}`;
  if (f.kind === 'sheet') return `/sheets/${f.id}`;
  if (f.kind === 'slides') return `/slides/${f.id}`;
  return null;
}

/** Why a file is suggested: "For Design review at 2:00 PM", "Kim Park changed it today", "You opened it yesterday". */
export function reasonText(r, now = Date.now()) {
  const when = (t) => { const d = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
  if (r.kind === 'meeting') return `For “${r.title}” at ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (r.kind === 'edited') return `${r.by} changed it ${when(r.at)}`;
  return `You opened it ${when(r.at)}`;
}

/** Suggested files at the top of My Drive (hidden or shown again with the arrow; kept in this browser). */
function Suggested({ onOpen }) {
  const [list, setList] = useState([]);
  const [shut, setShut] = useState(() => { try { return localStorage.getItem('nw-suggested-shut') === '1'; } catch { return false; } });
  useEffect(() => { get('/files/suggested').then(setList).catch(() => setList([])); }, []);
  if (!list.length) return null;
  const toggle = () => { setShut(!shut); try { localStorage.setItem('nw-suggested-shut', shut ? '0' : '1'); } catch { /* not kept */ } };
  return (
    <section className="drive-suggested" aria-label="Suggested">
      <button type="button" className="link-btn small suggested-head" aria-expanded={!shut} onClick={toggle}>{shut ? '▸' : '▾'} Suggested</button>
      {!shut && (
        <ul className="suggested-cards">
          {list.map((f) => (
            <li key={f.id}><button type="button" className="suggested-card" onClick={() => onOpen(f)} title={f.name}>
              <Icon name={f.kind === 'file' ? 'file' : f.kind} size={22} className={`ft ft-${f.kind}`} />
              <span className="grow"><strong className="ellipsis">{f.name}</strong><span className="muted small ellipsis">{reasonText(f.reason)}</span></span>
            </button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Search filters: [param, label, [[value, name]...]]. */
const LABEL_COLORS = [['#d93025', 'Red'], ['#e8710a', 'Orange'], ['#f9ab00', 'Yellow'], ['#188038', 'Green'], ['#12b5cb', 'Teal'], ['#1a73e8', 'Blue'], ['#9334e6', 'Purple'], ['#e52592', 'Pink'], ['#5f6368', 'Grey']];
const FILTERS = [
  ['type', 'Type', [['', 'Any type'], ['doc', 'Documents'], ['sheet', 'Spreadsheets'], ['slides', 'Presentations'], ['pdf', 'PDFs'], ['image', 'Pictures'], ['video', 'Videos'], ['audio', 'Audio'], ['archive', 'Archives (.zip)'], ['folder', 'Folders']]],
  ['owner', 'Owner', [['', 'Anyone'], ['me', 'Owned by me'], ['others', 'Not owned by me']]],
  ['modified', 'Modified', [['', 'Any time'], ['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['365', 'Last year']]],
  ['label', 'Label', null], // your own labels (filled in from them)
];

/** When something in the trash goes for good: "in 12 days", "tomorrow", or "never" when the company keeps the trash. */
export function goesIn(at, now = Date.now()) {
  if (!at) return 'Never';
  const days = Math.ceil((at - now) / 864e5);
  return days <= 1 ? (days <= 0 ? 'Soon' : 'Tomorrow') : `In ${days} days`;
}
const TITLES = { drives: 'Shared drives', shared: 'Shared with me', recent: 'Recent', starred: 'Starred', trash: 'Trash', approvals: 'Approvals', signatures: 'Signatures' };
const DRAG_TYPE = 'application/x-workspace-files';

export default function Drive() {
  const route = useDriveRoute();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const mail = useMailStatus();
  /** Email as attachment: a new message in Mail with the file attached (a document asks first: as Word, PDF…, or a link). */
  const emailFile = (f) => {
    const rec = { id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind };
    const draft = f.kind === 'file' ? { subject: f.name, files: [rec] } : { subject: f.name, convert: rec };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { toast('Your browser’s storage is off', 'error'); return; }
    navigate('/mail?compose_doc=1');
  };
  const [files, setFiles] = useState(null);
  const [crumbs, setCrumbs] = useState([]);
  // Sort and list/grid, kept for you on the server (the same on every computer).
  const [look, setLook] = useState(() => user.drive_view || { sort: 'name', desc: false, layout: 'list' });
  const changeLook = (change) => {
    const next = { ...look, ...change };
    setLook(next);
    put('/users/me/drive-view', change).then((v) => setUser?.({ ...user, drive_view: v })).catch(() => {});
  };
  const sortBy = (sort) => changeLook(look.sort === sort ? { desc: !look.desc } : { sort, desc: sort !== 'name' }); // newest and biggest first, to start with
  const [folder, setFolder] = useState(null);
  const [usage, setUsage] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState(null);
  const fileInput = useRef();
  const madeDrive = useRef(null); // a shared drive just made: its members are asked for next

  const filterQuery = route.filters ? FILTERS.filter(([k]) => route.filters[k]).map(([k]) => `&${k}=${encodeURIComponent(route.filters[k])}`).join('') : '';
  const key = `${route.view}:${route.folderId || ''}:${route.q || ''}:${filterQuery}:${route.label || ''}`;
  // Your labels (with how many files have each), for the sidebar.
  const [myLabels, setMyLabels] = useState([]);
  const loadLabels = useCallback(() => get('/files/labels').then(setMyLabels).catch(() => {}), []);
  useEffect(() => { loadLabels(); }, [loadLabels]);
  const labelColor = (name) => myLabels.find((l) => l.name === name)?.color;
  const setLabelColor = async (label, color) => { try { await put('/files/labels/color', { label, color }); loadLabels(); } catch (e) { toast(e.message, 'error'); } };

  const load = useCallback(async () => {
    if (route.view === 'approvals' || route.view === 'signatures') { setFiles([]); return; } // their own lists (Approvals.jsx, Signatures.jsx)
    try {
      let url = `/files?view=${route.view}`;
      if (route.folderId) url += `&parent=${route.folderId}`;
      if (route.view === 'search') url += `&q=${encodeURIComponent(route.q)}${filterQuery}`;
      if (route.view === 'label') url += `&label=${encodeURIComponent(route.label)}`;
      const [list, path, f] = await Promise.all([
        get(url),
        route.folderId ? get(`/files/${route.folderId}/path`) : [],
        route.folderId ? get(`/files/${route.folderId}`) : null,
      ]);
      setFiles(list);
      setCrumbs(path);
      setFolder(f);
    } catch (e) {
      toast(e.message, 'error');
      if (e.status === 404) navigate('/drive', { replace: true });
    }
    get('/files/usage').then(setUsage).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { setFiles(null); setSelected(null); setChecked(new Set()); load(); }, [load]);
  // Several files at once: tick them, then use the bar above the list.
  const [checked, setChecked] = useState(new Set());
  const toggleCheck = (id) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const picked = (files || []).filter((f) => checked.has(f.id));
  const zip = (ids) => { location.href = `/api/files/zip?ids=${ids.join(',')}`; };
  async function bulk(fn, msg) {
    const list = picked;
    let ok = 0;
    for (const f of list) { try { await fn(f); ok++; } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); } }
    if (ok && msg) toast(msg(ok));
    setChecked(new Set());
    load();
  }
  // Undo for moving and trashing: put each back (its folder, or out of the trash).
  const undoMove = (prev) => async () => {
    for (const { id, parent_id } of prev) { try { await patch(`/files/${id}`, { parent_id }); } catch (e) { toast(e.message, 'error'); } }
    toast('Moved back'); load();
  };
  async function trashWithUndo(list) {
    const done = [];
    for (const f of list) { try { await patch(`/files/${f.id}`, { trashed: true }); done.push(f); } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); } }
    if (done.length) {
      toast(done.length === 1 ? 'Moved to trash' : `Moved ${done.length} to trash`, 'info', { action: { label: 'Undo', onClick: async () => {
        for (const f of done) { try { await patch(`/files/${f.id}`, { trashed: false }); } catch (e) { toast(e.message, 'error'); } }
        toast(done.length === 1 ? 'Restored' : `Restored ${done.length}`); load();
      } } });
    }
    setChecked(new Set());
    load();
  }
  // Copies of several at once (next to each; a folder with what is in it); Undo moves the copies to the trash.
  async function copyMany(list, parentId) {
    try {
      const out = await post('/files/copy-many', { ids: list.map((f) => f.id), ...(parentId !== undefined && { parent_id: parentId }) });
      for (const x of out.filter((y) => y.error)) toast(`${list.find((f) => f.id === x.id)?.name}: ${x.error}`, 'error');
      const copies = out.filter((x) => x.copy).map((x) => x.copy);
      for (const c of copies.filter((x) => x.skipped)) toast(`${c.name}: ${c.skipped} item${c.skipped === 1 ? ' was' : 's were'} left out because you can’t copy ${c.skipped === 1 ? 'it' : 'them'}`, 'error');
      if (copies.length) {
        toast(copies.length === 1 ? 'Made a copy' : `Made ${copies.length} copies`, 'info', { action: { label: 'Undo', onClick: async () => {
          for (const c of copies) { try { await patch(`/files/${c.id}`, { trashed: true }); } catch (e) { toast(e.message, 'error'); } }
          toast('Copies moved to trash'); load();
        } } });
      }
    } catch (e) { toast(e.message, 'error'); }
    setChecked(new Set());
    load();
  }
  // Drag files onto a folder (in the list or the path above it) to move them there.
  const [dropOn, setDropOn] = useState(null);
  async function moveInto(ids, folderId) {
    const moved = [];
    for (const id of ids) {
      if (id === folderId) continue;
      const before = (files || []).find((f) => f.id === id)?.parent_id ?? null;
      try { await patch(`/files/${id}`, { parent_id: folderId }); moved.push({ id, parent_id: before }); } catch (e) { toast(e.message, 'error'); }
    }
    if (moved.length) toast(`Moved ${moved.length} item${moved.length === 1 ? '' : 's'}`, 'info', { action: { label: 'Undo', onClick: undoMove(moved) } });
    setChecked(new Set());
    load();
  }
  const dropTarget = (folderId) => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropOn(folderId ?? 'root'); } },
    onDragLeave: () => setDropOn(null),
    onDrop: (e) => { const raw = e.dataTransfer.getData(DRAG_TYPE); if (!raw) return; e.preventDefault(); e.stopPropagation(); setDropOn(null); moveInto(JSON.parse(raw), folderId ?? null); },
  });
  useEffect(() => onLive((m) => {
    if (m.type === 'files-changed' || m.type === 'content-changed' || m.type === 'live-connected') load();
  }), [load]);
  // People asking for access to your files (a notification links here with ?requests=1).
  const [requests, setRequests] = useState([]);
  // Approvals waiting for you, counted beside Approvals.
  const [waitingCount, setWaitingCount] = useState(0);
  useEffect(() => {
    const count = () => get('/approvals').then((r) => setWaitingCount(r.waiting.length)).catch(() => {});
    count();
    return onLive((m) => { if (m.type === 'approvals-changed' || m.type === 'live-connected') count(); });
  }, []);
  // Documents waiting for your signature, counted beside Signatures.
  const [signCount, setSignCount] = useState(0);
  useEffect(() => {
    const count = () => get('/signatures').then((r) => setSignCount(r.waiting.length)).catch(() => {});
    count();
    return onLive((m) => { if (m.type === 'signatures-changed' || m.type === 'live-connected') count(); });
  }, []);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const loadRequests = useCallback(() => get('/files/access-requests').then(setRequests).catch(() => {}), []);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  useEffect(() => onLive((m) => { if (m.type === 'access-requests' || m.type === 'live-connected') loadRequests(); }), [loadRequests]);
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => { if (searchParams.get('requests')) { setRequestsOpen(true); setSearchParams({}, { replace: true }); } }, [searchParams, setSearchParams]);
  // /drive?shared=1: something was shared to Workspace from another app (see public/sw.js).
  const [sharedIn, setSharedIn] = useState(null);
  useEffect(() => {
    if (!searchParams.get('shared')) return;
    setSearchParams({}, { replace: true });
    readShared().then((v) => { if (v) setSharedIn(v); });
  }, [searchParams, setSearchParams]);
  // /drive?preview=<file id>&comment=<id>: a file's preview (e.g. from a comment notification).
  useEffect(() => {
    const id = searchParams.get('preview');
    if (!id) return;
    const comment = searchParams.get('comment');
    setSearchParams({}, { replace: true });
    get(`/files/${id}`).then((f) => setDialog({ type: 'preview', file: f, comment })).catch((e) => toast(e.message, 'error'));
  }, [searchParams, setSearchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const parentId = route.view === 'mine' ? route.folderId : null;
  const canCreate = route.view === 'mine' && (!folder || folder.role === 'editor' || folder.role === 'owner');

  /**
   * Upload files; each may come with `dir`, the folders it was in (uploading or dropping a folder),
   * which are found or made here first so the folder arrives as it was.
   */
  async function startUploads(list) {
    if (!canCreate) return toast('Open a folder you can edit to upload files', 'error');
    const items = [...list].map((entry) => {
      const file = entry instanceof File ? entry : entry.file;
      const dir = entry instanceof File ? (file.webkitRelativePath || '').split('/').slice(0, -1) : entry.dir;
      return { id: Math.random(), name: [...(dir || []), file.name].join('/'), progress: 0, file, dir: dir || [] };
    });
    if (!items.length) return;
    setUploads((u) => [...u, ...items]);
    const folders = new Map(); // "a/b" → folder id
    let converted = 0;
    for (const it of items) {
      try {
        let into = parentId;
        if (it.dir.length) {
          const key = it.dir.join('/');
          if (!folders.has(key)) folders.set(key, (await post('/files/folder-path', { parent_id: parentId, path: it.dir })).id);
          into = folders.get(key);
        }
        const rec = await uploadFile(it.file, into, (p) => setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, progress: p } : x))), { convert: true });
        if (rec?.converted_from) converted++;
        if (rec?.convert_error) toast(`${it.file.name} was uploaded as it is: ${rec.convert_error}`, 'info');
        setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, progress: 1, done: true } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, error: e.message } : x)));
      }
    }
    if (converted) toast(`${converted === 1 ? '1 file' : `${converted} files`} converted to ${converted === 1 ? 'a document, spreadsheet or presentation' : 'documents, spreadsheets and presentations'} (the original${converted === 1 ? ' is' : 's are'} in the trash)`);
    load();
  }

  // Upload new version: pick a file, it replaces the contents (the old ones stay in the history).
  const versionInput = useRef();
  const versionFor = useRef(null);
  const folderInput = useRef();
  async function uploadNewVersion(file) {
    const target = versionFor.current;
    if (!file || !target) return;
    const item = { id: Math.random(), name: `${target.name} (new version)`, progress: 0 };
    setUploads((u) => [...u, item]);
    try {
      await uploadVersion(file, target.id, (p) => setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, progress: p } : x))));
      setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, progress: 1, done: true } : x)));
      toast(`New version of ${target.name} uploaded`);
    } catch (e) {
      setUploads((u) => u.map((x) => (x.id === item.id ? { ...x, error: e.message } : x)));
    }
    load();
  }

  // A Word, Excel or PowerPoint file: make an editable Docs, Sheets or Slides copy and open it.
  async function openAs(f) {
    toast(`Opening ${f.name}…`);
    try { navigate(openPath(await post(`/files/${f.id}/open-as`))); } catch (e) { toast(e.message, 'error'); }
  }

  async function create(kind) {
    try {
      const f = await post('/files/new', { kind, parent_id: parentId });
      navigate(openPath(f));
    } catch (e) { toast(e.message, 'error'); }
  }

  function open(f) {
    const p = openPath(f);
    if (p) navigate(p);
    else setDialog({ type: 'preview', file: f });
  }

  const act = (fn, msg) => async () => {
    try { await fn(); if (msg) toast(msg); load(); } catch (e) { toast(e.message, 'error'); }
  };

  function itemMenu(f) {
    // A shortcut: open what it points to, find where that really is, or take the shortcut away.
    if (f.shortcut_id) return [
      !f.broken && { label: 'Open', icon: fileIcon(f), onClick: () => open(f) },
      !f.broken && { label: 'Show file location', icon: 'folder', onClick: async () => {
        try { const p = await get(`/files/${f.id}/path`); const up = p[p.length - 2]; navigate(up ? `/drive/folder/${up.id}` : f.owner_id === user.id ? '/drive' : '/drive/shared'); } catch (e) { toast(e.message, 'error'); }
      } },
      !f.broken && { label: 'Details', icon: 'more', onClick: () => setDialog({ type: 'details', file: f }) },
      f.shortcut_removable && { label: 'Remove shortcut', icon: 'trash', danger: true, onClick: act(() => del(`/files/shortcuts/${f.shortcut_id}`), 'Shortcut removed (the file itself is still there)') },
    ];
    const canEdit = f.role === 'owner' || f.role === 'editor';
    if (route.view === 'trash') return [
      { label: 'Restore', icon: 'restore', onClick: act(() => patch(`/files/${f.id}`, { trashed: false }), 'Restored') },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', file: f }) },
    ];
    return [
      { label: 'Open', icon: fileIcon(f), onClick: () => open(f) },
      officeAs(f) && { label: `Open as ${officeAs(f).what}`, icon: officeAs(f).icon, onClick: () => openAs(f) },
      f.kind === 'file' && !viewOnly(f) && { label: 'Download', icon: 'download', onClick: () => { location.href = `/api/files/${f.id}/raw?download`; } },
      f.kind === 'folder' && { label: 'Download as .zip', icon: 'download', onClick: () => zip([f.id]) },
      mail?.enabled && f.kind !== 'folder' && !viewOnly(f) && { label: 'Email as attachment', icon: 'mail', onClick: () => emailFile(f) },
      { label: 'Details', icon: 'more', onClick: () => setDialog({ type: 'details', file: f }) },
      user.is_admin && ['doc', 'sheet', 'slides'].includes(f.kind) && { label: f.template ? 'Remove from company templates' : 'Make a company template', icon: 'doc',
        onClick: async () => { try { await put(`/files/${f.id}/template`, { template: !f.template }); toast(f.template ? 'No longer a company template' : 'Everyone in your company can now start from it (New → From a template)'); load(); } catch (e) { toast(e.message, 'error'); } } },
      f.owner_id === user.id && ['doc', 'sheet', 'slides'].includes(f.kind) && f.template !== 1 && { label: f.template === 2 ? 'Remove from my templates' : 'Use as my template', icon: 'copy',
        onClick: async () => { try { await put(`/files/${f.id}/my-template`, { template: f.template !== 2 }); toast(f.template === 2 ? 'Removed from your templates' : 'Added to your templates: New → From a template'); load(); } catch (e) { toast(e.message, 'error'); } } },
      { label: 'Labels…', icon: 'edit', onClick: () => setDialog({ type: 'labels', file: f }) },
      { label: f.starred ? 'Remove star' : 'Add star', icon: f.starred ? 'star' : 'staroutline', onClick: act(() => put(`/files/${f.id}/star`, { starred: !f.starred }), f.starred ? 'Star removed' : 'Starred') },
      { label: 'Change notifications on/off', icon: 'bell', onClick: async () => {
        try { const now = (await get(`/files/${f.id}/watch`)).watching; await put(`/files/${f.id}/watch`, { on: !now }); toast(now ? `No more notifications about “${f.name}”` : `You’ll get a notification when someone else changes “${f.name}”`); } catch (e) { toast(e.message, 'error'); }
      } },
      '-',
      (f.role === 'owner' || (f.is_drive && f.role === 'editor')) && { label: f.is_drive ? 'Manage members' : 'Share', icon: 'share', onClick: () => setDialog({ type: 'share', file: f }) },
      f.role === 'owner' && f.owner_id === user.id && { label: 'Transfer ownership…', icon: 'person', onClick: () => setDialog({ type: 'transfer', file: f }) },
      canEdit && { label: 'Rename', icon: 'edit', onClick: () => setDialog({ type: 'rename', file: f }) },
      canEdit && { label: 'Move to…', icon: 'move', onClick: () => setDialog({ type: 'move', files: [f] }) },
      pdfPart(f) === 'pdf' && ['owner', 'editor'].includes(f.role) && !f.locked_at && { label: 'Send for signature…', icon: 'send', onClick: () => setDialog({ type: 'pdf-send-sign', files: [f] }) },
      pdfPart(f) === 'pdf' && { label: 'Fill & sign…', icon: 'edit', onClick: () => setDialog({ type: 'pdf-sign', files: [f] }) },
      pdfPart(f) === 'pdf' && { label: 'Organise pages…', icon: 'pdf', onClick: () => setDialog({ type: 'pdf-organize', files: [f] }) },
      pdfPart(f) === 'pdf' && !viewOnly(f) && { label: 'Extract pages…', icon: 'pdf', onClick: () => setDialog({ type: 'pdf-extract', files: [f] }) },
      !f.is_drive && !viewOnly(f) && { label: 'Make a copy', icon: 'copy', onClick: () => copyMany([f]) },
      !f.is_drive && !viewOnly(f) && { label: 'Copy to…', icon: 'copy', onClick: () => setDialog({ type: 'copyto', files: [f] }) },
      { label: 'Add shortcut to Drive…', icon: 'link', onClick: () => setDialog({ type: 'shortcut', files: [f] }) },
      f.kind !== 'folder' && '-',
      f.kind !== 'folder' && canEdit && !f.locked_at && { label: 'Lock (stop changes)', icon: 'lock', onClick: act(() => put(`/files/${f.id}/lock`, { locked: true }), 'Locked: nobody can change it until it’s unlocked') },
      f.locked_at && (f.locked_by === user.id || f.role === 'owner') && { label: 'Unlock', icon: 'lock', onClick: act(() => put(`/files/${f.id}/lock`, { locked: false }), 'Unlocked') },
      f.kind === 'file' && canEdit && !f.locked_at && { label: 'Upload new version', icon: 'upload', onClick: () => { versionFor.current = f; versionInput.current.click(); } },
      f.kind !== 'folder' && { label: 'Version history', icon: 'clock', onClick: () => setDialog({ type: 'versions', file: f }) },
      f.kind !== 'folder' && canEdit && { label: 'Request approval…', icon: 'check', onClick: () => setDialog({ type: 'approval', file: f }) },
      canEdit && '-',
      canEdit && { label: 'Move to trash', icon: 'trash', danger: true, onClick: () => trashWithUndo([f]) },
    ];
  }

 // The list as chosen: Recent stays newest first, search results best match first, until you sort them.
  const sortChosen = look.sort !== 'name' || look.desc;
  const shown = files ? (['recent', 'search'].includes(route.view) && !sortChosen ? files : sortFiles(files, look)) : [];
  const sortHead = (key, label, cls = '') => (
    <th className={cls} aria-sort={look.sort === key ? (look.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => sortBy(key)} title={`Sort by ${label.toLowerCase()}`}>{label}{look.sort === key && <span aria-hidden="true"> {look.desc ? '↓' : '↑'}</span>}</button>
    </th>
  );
  const title = route.view === 'label' ? `🏷 ${route.label}` : route.view === 'search' ? (route.q ? `Search results for “${route.q}”` : 'Search') : TITLES[route.view];
  const setFilter = (k, v) => {
    const p = new URLSearchParams({ q: route.q });
    for (const [f] of FILTERS) { const val = f === k ? v : route.filters[f]; if (val) p.set(f, val); }
    navigate(`/drive/search?${p}`, { replace: true });
  };

  return (
    <div className="drive">
      <aside className="subnav">
        <Menu align="left" trigger={(p) => <button className="btn new-btn" {...p} disabled={!canCreate}><Icon name="plus" /> New</button>} items={[
          { label: 'New folder', icon: 'folder', onClick: () => setDialog({ type: 'folder' }) },
          '-',
          { label: 'Upload files', icon: 'upload', onClick: () => fileInput.current.click() },
          { label: 'Upload folder', icon: 'folder', onClick: () => folderInput.current.click() },
          { label: 'Scan to PDF…', icon: 'pdf', onClick: () => setDialog({ type: 'scan' }) },
          '-',
          { label: 'Document', icon: 'doc', onClick: () => create('doc') },
          { label: 'Spreadsheet', icon: 'sheet', onClick: () => create('sheet') },
          { label: 'Presentation', icon: 'slides', onClick: () => create('slides') },
          { label: 'From a template…', icon: 'doc', onClick: () => setDialog({ type: 'templates' }) },
        ]} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { startUploads(e.target.files); e.target.value = ''; }} />
        <input ref={folderInput} type="file" multiple hidden webkitdirectory="" aria-label="Folder to upload" onChange={(e) => { startUploads(e.target.files); e.target.value = ''; }} />
        <NavLink end to="/drive" className={() => `subnav-item ${route.view === 'mine' && !crumbs[0]?.is_drive ? 'active' : ''}`}><Icon name="folder" />My Drive</NavLink>
        <NavLink to="/drive/drives" className={() => `subnav-item ${route.view === 'drives' || (route.view === 'mine' && crumbs[0]?.is_drive) ? 'active' : ''}`}><Icon name="people" />Shared drives</NavLink>
        <NavLink to="/drive/shared" className="subnav-item"><Icon name="share" />Shared with me</NavLink>
        <NavLink to="/drive/recent" className="subnav-item"><Icon name="clock" />Recent</NavLink>
        <NavLink to="/drive/starred" className="subnav-item"><Icon name="staroutline" />Starred</NavLink>
        <NavLink to="/drive/approvals" className="subnav-item"><Icon name="check" /><span className="grow">Approvals</span>{waitingCount > 0 && <span className="count" aria-label={`${waitingCount} waiting for you`}>{waitingCount}</span>}</NavLink>
        <NavLink to="/drive/signatures" className="subnav-item"><span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>✍️</span><span className="grow">Signatures</span>{signCount > 0 && <span className="count" aria-label={`${signCount} waiting for your signature`}>{signCount}</span>}</NavLink>
        <NavLink to="/drive/trash" className="subnav-item"><Icon name="trash" />Trash</NavLink>
        {myLabels.length > 0 && <div className="subnav-title">Labels</div>}
        {myLabels.map((l) => (
          <div key={l.name} className="drive-label-row">
            <NavLink to={`/drive/label/${encodeURIComponent(l.name)}`} className="subnav-item" aria-label={`Label ${l.name}, ${l.count}`}>
              {l.color ? <span className="drive-label-dot" style={{ background: l.color }} aria-hidden="true" /> : <span aria-hidden="true" style={{ width: 24, textAlign: 'center' }}>🏷</span>}<span className="grow ellipsis">{l.name}</span><span className="count">{l.count}</span></NavLink>
            <Menu align="right" trigger={(p) => <button type="button" className="icon-btn drive-label-menu" aria-label={`Edit label ${l.name}`} title="Rename or delete" {...p}><Icon name="more" size={16} /></button>}
              items={[...LABEL_COLORS.map(([c, name]) => ({ label: `${l.color === c ? '✓ ' : ''}${name}`, onClick: () => setLabelColor(l.name, c) })), { label: 'No colour', onClick: () => setLabelColor(l.name, null) }, '-',
                { label: 'Rename label…', onClick: () => setDialog({ type: 'label-rename', label: l.name }) }, { label: 'Delete label', danger: true, onClick: () => setDialog({ type: 'label-delete', label: l.name }) }]} />
          </div>
        ))}
        {requests.length > 0 && <button type="button" className="subnav-item" onClick={() => setRequestsOpen(true)}><Icon name="lock" /><span className="grow">Access requests</span><span className="count">{requests.length}</span></button>}
        {usage && (
          <button type="button" className="usage" aria-label="Storage" title="See what takes up space" onClick={() => setDialog({ type: 'storage' })}>
            <div className="muted small">{formatBytes(usage.used)} used{usage.disk && ` · ${formatBytes(usage.disk.free)} free on NAS`}</div>
            {usage.disk && <div className="bar"><div style={{ width: `${Math.min(100, (1 - usage.disk.free / usage.disk.total) * 100)}%` }} /></div>}
          </button>
        )}
      </aside>

      <section
        className={`drive-main ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { if (canCreate && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={async (e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) startUploads(await droppedFiles(e.dataTransfer)); }}
      >
        <div className="drive-head">
          {title ? <h1>{title}</h1> : (
            <nav className="crumbs" aria-label="Folder path">
              {crumbs[0]?.is_drive ? <button className="crumb" onClick={() => navigate('/drive/drives')}>Shared drives</button>
                : <button className={`crumb ${dropOn === 'root' ? 'drop-on' : ''}`} onClick={() => navigate('/drive')} {...dropTarget(null)}>My Drive</button>}
              {crumbs.map((c) => (
                <span key={c.id} className="crumb-wrap"><Icon name="right" size={18} />
                  <button className={`crumb ${dropOn === c.id ? 'drop-on' : ''}`} onClick={() => navigate(`/drive/folder/${c.id}`)} {...dropTarget(c.id)}>{c.name}</button></span>
              ))}
            </nav>
          )}
          {route.view === 'trash' && files?.length > 0 && (
            <button className="btn" onClick={() => setDialog({ type: 'empty-trash' })}>Empty trash</button>
          )}
          {route.view === 'drives' && <button className="btn" onClick={() => setDialog({ type: 'drive' })}><Icon name="plus" /> New shared drive</button>}
          {route.view === 'mine' && crumbs[0]?.is_drive && (
            <button className="btn" onClick={async () => { try { setDialog({ type: 'share', file: await get(`/files/${crumbs[0].id}`) }); } catch (e) { toast(e.message, 'error'); } }}>
              <Icon name="people" /> Members
            </button>
          )}
          {!['approvals', 'signatures'].includes(route.view) && (
            <div className="drive-layout" role="group" aria-label="Show files as">
              <button type="button" className={look.layout === 'list' ? 'on' : ''} aria-pressed={look.layout === 'list'} onClick={() => changeLook({ layout: 'list' })} title="List"><Icon name="menu" size={18} /><span className="sr-only">List</span></button>
              <button type="button" className={look.layout === 'grid' ? 'on' : ''} aria-pressed={look.layout === 'grid'} onClick={() => changeLook({ layout: 'grid' })} title="Grid"><Icon name="apps" size={18} /><span className="sr-only">Grid</span></button>
              {look.layout === 'grid' && <select aria-label="Sort by" value={`${look.sort}:${look.desc ? 'desc' : 'asc'}`} onChange={(e) => { const [sort, dir] = e.target.value.split(':'); changeLook({ sort, desc: dir === 'desc' }); }}>
                <option value="name:asc">Name A → Z</option><option value="name:desc">Name Z → A</option>
                <option value="modified:desc">Newest first</option><option value="modified:asc">Oldest first</option>
                <option value="size:desc">Largest first</option><option value="size:asc">Smallest first</option>
              </select>}
            </div>
          )}
        </div>
        {route.view === 'mine' && !route.folderId && <Suggested onOpen={open} />}
        {route.view === 'search' && (
          <div className="search-filters" role="group" aria-label="Filters">
            {FILTERS.filter(([k]) => k !== 'label' || myLabels.length || route.filters.label).map(([k, label, given]) => [k, label, given || [['', 'Any label'], ...[...new Set([...myLabels.map((l) => l.name), ...(route.filters.label ? [route.filters.label] : [])])].map((n) => [n, n])]]).map(([k, label, options]) => (
              <select key={k} aria-label={label} className={route.filters[k] ? 'on' : ''} value={route.filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
                {options.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
              </select>
            ))}
            {FILTERS.some(([k]) => route.filters[k]) && <button type="button" className="link-btn small" onClick={() => navigate(`/drive/search?q=${encodeURIComponent(route.q)}`, { replace: true })}>Clear filters</button>}
          </div>
        )}
        {picked.length > 0 && (
          <div className="select-bar" role="toolbar" aria-label="Selected files">
            <strong>{picked.length} selected</strong>
            {route.view === 'trash' ? <>
              <button className="btn small" onClick={() => bulk((f) => patch(`/files/${f.id}`, { trashed: false }), (n) => `Restored ${n}`)}><Icon name="restore" size={16} /> Restore</button>
            </> : <>
              <button className="btn small" onClick={() => zip(picked.map((f) => f.id))}><Icon name="download" size={16} /> Download</button>
              <button className="btn small" onClick={() => bulk((f) => put(`/files/${f.id}/star`, { starred: true }), (n) => `Starred ${n}`)}><Icon name="star" size={16} /> Star</button>
              <button className="btn small" onClick={() => setDialog({ type: 'bulk-label', files: picked })}><span aria-hidden="true">🏷</span> Label…</button>
              {picked.every(pdfPart) && <button className="btn small" onClick={() => setDialog({ type: 'pdf-combine', files: picked })}><Icon name="pdf" size={16} /> Combine into PDF</button>}
              {picked.length > 1 && picked.every((f) => !f.is_drive) && <button className="btn small" onClick={() => copyMany(picked)}><Icon name="copy" size={16} /> Make a copy</button>}
              {picked.length > 1 && picked.every((f) => !f.is_drive) && <button className="btn small" onClick={() => setDialog({ type: 'copyto', files: picked })}><Icon name="copy" size={16} /> Copy to</button>}
              {picked.every((f) => f.role === 'owner' || f.role === 'editor') && <>
                <button className="btn small" onClick={() => setDialog({ type: 'move', files: picked })}><Icon name="move" size={16} /> Move</button>
                {picked.length > 1 && <button className="btn small" onClick={() => setDialog({ type: 'rename-many', files: picked })}><Icon name="edit" size={16} /> Rename</button>}
                <button className="btn small danger" onClick={() => trashWithUndo(picked)}><Icon name="trash" size={16} /> Trash</button>
              </>}
            </>}
            <div className="grow" />
            <button className="btn small" onClick={() => setChecked(new Set())}>Clear</button>
          </div>
        )}
        {folder && folder.owner_id !== user.id && <p className="muted small">Owned by {folder.owner_name} · you can {folder.role === 'viewer' ? 'view' : folder.role === 'commenter' ? 'view and comment' : 'edit'}</p>}

        {route.view === 'approvals' ? <ApprovalsView /> : route.view === 'signatures' ? <SignaturesView /> : files === null ? <p className="muted">Loading…</p> : files.length === 0 ? (
          route.view === 'trash' ? <Empty icon="trash" title="Trash is empty" />
            : route.view === 'search' ? <Empty icon="search" title="No matching files" />
              : route.view === 'shared' ? <Empty icon="people" title="Nothing shared with you yet" />
              : route.view === 'drives' ? <Empty icon="people" title="No shared drives yet">A shared drive belongs to a team: everyone in it sees the same files, and what people add stays when they leave. Make one with New shared drive.</Empty>
                : <Empty icon="upload" title="Drop files here">or use the New button to create a folder, document or spreadsheet</Empty>
        ) : look.layout === 'grid' ? (
          <ul className="file-grid" aria-label="Files">
            {shown.map((f) => (
              <li key={f.shortcut_id ? `s-${f.shortcut_id}` : f.id} className={`file-tile ${selected === (f.shortcut_id || f.id) || checked.has(f.id) ? 'selected' : ''} ${dropOn === f.id ? 'drop-on' : ''}`}
                draggable={!f.shortcut_id && route.view !== 'trash' && (f.role === 'owner' || f.role === 'editor')}
                onDragStart={(e) => { const ids = checked.has(f.id) ? [...checked] : [f.id]; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; }}
                {...(!f.shortcut_id && f.kind === 'folder' && route.view !== 'trash' && (f.role === 'editor' || f.role === 'owner') ? dropTarget(f.id) : {})}>
                <button type="button" className="tile-face" aria-label={f.name} title={f.name}
                  onClick={(e) => { if (!f.shortcut_id && (e.shiftKey || e.metaKey || e.ctrlKey)) toggleCheck(f.id); else setSelected(f.shortcut_id || f.id); }}
                  onDoubleClick={() => { if (route.view === 'trash') return; if (f.broken) toast('You can no longer open what this shortcut points to', 'error'); else open(f); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && route.view !== 'trash') { e.preventDefault(); open(f); } }}>
                  <span className="tile-thumb">{isPicture(f) && !f.broken ? <img src={`/api/files/${f.id}/raw`} alt="" loading="lazy" draggable={false} />
                    : <Icon name={fileIcon(f)} size={48} className={`ft ft-${fileIcon(f)}`} style={f.color ? { color: f.color } : undefined} />}</span>
                  <span className="tile-name"><Icon name={fileIcon(f)} size={16} className={`ft ft-${fileIcon(f)}`} style={f.color ? { color: f.color } : undefined} />{f.shortcut_id && <span aria-label="Shortcut">↪</span>}<span className="ellipsis">{f.name}</span></span>
                  <span className="tile-meta muted small">{route.view === 'trash' ? goesIn(f.deletes_at) : formatDate(f.updated_at)}{f.kind !== 'folder' && f.size ? ` · ${formatBytes(f.size)}` : ''}{f.kind === 'folder' && f.folder_files !== undefined ? ` · ${f.folder_files ? `${f.folder_files} file${f.folder_files === 1 ? '' : 's'}, ${formatBytes(f.folder_size)}` : 'empty'}` : ''}</span>
                </button>
                {!f.shortcut_id && <input type="checkbox" className="tile-check" aria-label={`Select ${f.name}`} checked={checked.has(f.id)} onChange={() => toggleCheck(f.id)} />}
                <Menu trigger={(p) => <button className="icon-btn tile-menu" aria-label={`Actions for ${f.name}`} {...p}><Icon name="more" /></button>} items={itemMenu(f)} />
              </li>
            ))}
          </ul>
        ) : (
          <table className="files">
            <thead><tr><th className="check-col"><input type="checkbox" aria-label="Select all" checked={files.length > 0 && picked.length === files.length}
              ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < files.length; }}
              onChange={(e) => setChecked(e.target.checked ? new Set(files.filter((f) => !f.shortcut_id).map((f) => f.id)) : new Set())} /></th>{sortHead('name', 'Name')}<th className="hide-sm">Owner</th>{route.view === 'trash' ? <th className="hide-sm">Deleted for good</th> : sortHead('modified', 'Modified', 'hide-sm')}{sortHead('size', 'Size', 'hide-sm')}<th aria-label="Actions" /></tr></thead>
            <tbody>
              {shown.map((f) => f.shortcut_id ? <ShortcutRow key={`s-${f.shortcut_id}`} f={f} me={user.id} selected={selected === f.shortcut_id} onSelect={() => setSelected(f.shortcut_id)}
                onOpen={() => (f.broken ? toast('You can no longer open what this shortcut points to', 'error') : open(f))} menu={itemMenu(f)} /> : (
                <tr key={f.id} className={`${selected === f.id || checked.has(f.id) ? 'selected' : ''} ${dropOn === f.id ? 'drop-on' : ''}`} tabIndex={0}
                  draggable={route.view !== 'trash' && (f.role === 'owner' || f.role === 'editor')}
                  onDragStart={(e) => { const ids = checked.has(f.id) ? [...checked] : [f.id]; e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'; }}
                  {...(f.kind === 'folder' && route.view !== 'trash' && (f.role === 'editor' || f.role === 'owner') ? dropTarget(f.id) : {})}
                  onClick={(e) => { if (e.shiftKey || e.metaKey || e.ctrlKey) toggleCheck(f.id); else setSelected(f.id); }} onDoubleClick={() => route.view !== 'trash' && open(f)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && route.view !== 'trash') open(f); if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); toggleCheck(f.id); } }}>
                  <td className="check-col" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${f.name}`} checked={checked.has(f.id)} onChange={() => toggleCheck(f.id)} /></td>
                  <td className="name"><Icon name={fileIcon(f)} className={`ft ft-${fileIcon(f)}`} style={f.color ? { color: f.color } : undefined} /><span className="name-text">{f.name}{f.match && <MatchText text={f.match} />}{f.drive_name && <span className="muted small"> · in {f.drive_name}</span>}{f.labels?.map((l) => <span key={l} className={`file-label ${labelColor(l) ? 'coloured' : ''}`} style={labelColor(l) ? { '--lc': labelColor(l) } : undefined}>{l}</span>)}</span>{f.starred && <Icon name="star" size={14} className="star-mark" title="Starred" />}{f.locked_at && <span className="lock-mark" title={`Locked by ${f.locked_by_name}`} aria-label="Locked"><Icon name="lock" size={14} /></span>}</td>
                  <td className="hide-sm muted">{f.owner_id === user.id ? 'me' : f.owner_name}</td>
                  <td className="hide-sm muted">{route.view === 'trash' ? (f.kept ? <span title="Your company is keeping it (a legal hold)">Kept</span> : goesIn(f.deletes_at)) : formatDate(f.updated_at)}</td>
                  <td className="hide-sm muted">{f.kind === 'folder' ? (f.folder_size === undefined ? '—' : <span title={`${f.folder_files} file${f.folder_files === 1 ? '' : 's'} inside`}>{f.folder_files ? formatBytes(f.folder_size) : 'Empty'}</span>) : formatBytes(f.size)}</td>
                  <td className="actions">
                    <Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${f.name}`} {...p}><Icon name="more" /></button>} items={itemMenu(f)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dragging && <div className="drop-hint"><Icon name="upload" size={40} />Drop to upload</div>}
      </section>

      {uploads.length > 0 && (
        <div className="upload-panel">
          <div className="upload-head">
            <strong>Uploads ({uploads.filter((u) => u.done).length}/{uploads.length})</strong>
            <button className="icon-btn" aria-label="Close uploads" onClick={() => setUploads((u) => u.filter((x) => !x.done && !x.error))}><Icon name="close" size={18} /></button>
          </div>
          {uploads.map((u) => (
            <div key={u.id} className="upload-row">
              <span className="ellipsis">{u.name}</span>
              {u.error ? <span className="error small">{u.error}</span> : u.done ? <Icon name="check" size={18} className="ok" /> : <span className="small muted">{Math.round(u.progress * 100)}%</span>}
            </div>
          ))}
        </div>
      )}

      {dialog?.type === 'folder' && (
        <PromptModal title="New folder" label="Folder name" initial="Untitled folder" confirm="Create" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await post('/files/folder', { name, parent_id: parentId }); load(); }} />
      )}
      {dialog?.type === 'drive' && (
        <PromptModal title="New shared drive" label="Name" initial="" confirm="Create" onClose={() => { setDialog(madeDrive.current ? { type: 'share', file: madeDrive.current } : null); madeDrive.current = null; }}
          onSubmit={async (name) => { const d = await post('/files/drives', { name }); madeDrive.current = d; navigate(`/drive/folder/${d.id}`); }} />
      )}
      {sharedIn && <SharedInDialog shared={sharedIn} onClose={() => setSharedIn(null)} onSaved={(parent) => { setSharedIn(null); if (parent) navigate(`/drive/folder/${parent}`); else load(); }} />}
      {dialog?.type === 'scan' && <ScanDialog onClose={() => setDialog(null)} onDone={(file) => { setDialog(null); startUploads([file]); }} />}
      {dialog?.type === 'storage' && <StorageDialog onClose={() => setDialog(null)} onChanged={load} />}
      {dialog?.type === 'transfer' && <TransferDialog file={dialog.file} onClose={() => setDialog(null)} onDone={load} />}
      {dialog?.type === 'rename' && (
        <PromptModal title="Rename" label="New name" initial={dialog.file.name} onClose={() => setDialog(null)}
          onSubmit={async (name) => { await patch(`/files/${dialog.file.id}`, { name }); load(); }} />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmModal title="Delete forever?" message={`“${dialog.file.name}” will be deleted permanently. This cannot be undone.`} confirm="Delete forever"
          onClose={() => setDialog(null)} onConfirm={async () => { await del(`/files/${dialog.file.id}`); load(); }} />
      )}
      {dialog?.type === 'empty-trash' && (
        <ConfirmModal title="Empty trash?" message="All items in the trash will be deleted permanently. This cannot be undone." confirm="Empty trash"
          onClose={() => setDialog(null)} onConfirm={async () => { await post('/files/empty-trash'); load(); }} />
      )}
      {dialog?.type === 'share' && <ShareDialog file={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'approval' && <RequestApproval file={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'move' && <MoveDialog files={dialog.files} onClose={() => setDialog(null)} onMoved={(moved) => { setChecked(new Set()); load(); if (moved?.length) toast(moved.length === 1 ? 'Moved' : `Moved ${moved.length} items`, 'info', { action: { label: 'Undo', onClick: undoMove(moved) } }); }} />}
      {dialog?.type === 'pdf-combine' && <PdfCombineDialog files={dialog.files} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setChecked(new Set()); load(); }} />}
      {dialog?.type === 'pdf-sign' && <Suspense fallback={null}><PdfSignDialog file={dialog.files[0]} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} /></Suspense>}
      {dialog?.type === 'pdf-organize' && <Suspense fallback={null}><PdfOrganizeDialog file={dialog.files[0]} canEdit={['owner', 'editor'].includes(dialog.files[0].role) && !dialog.files[0].locked_at} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} /></Suspense>}
      {dialog?.type === 'pdf-send-sign' && <SendForSignature file={dialog.files[0]} onClose={(sent) => { setDialog(null); if (sent) load(); }} />}
      {dialog?.type === 'pdf-extract' && <PdfExtractDialog file={dialog.files[0]} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog?.type === 'copyto' && <MoveDialog copy files={dialog.files} onClose={() => setDialog(null)} onCopy={(to) => copyMany(dialog.files, to)} />}
      {dialog?.type === 'shortcut' && <MoveDialog shortcut files={dialog.files} onClose={() => setDialog(null)} onMoved={() => load()} />}
      {dialog?.type === 'preview' && <Preview file={dialog.file} comment={dialog.comment} onClose={() => setDialog(null)} onOpenAs={() => { setDialog(null); openAs(dialog.file); }} />}
      {requestsOpen && <AccessRequests list={requests} onClose={() => setRequestsOpen(false)} onChanged={() => { loadRequests(); load(); }} />}
      {dialog?.type === 'templates' && <TemplatesDialog onClose={() => setDialog(null)} onPick={async (t) => {
        try {
          const f = t.builtIn ? await post('/files/new', { kind: t.kind, name: t.name, parent_id: parentId, content: t.content() }) : await post(`/files/templates/${t.id}/use`, { parent_id: parentId });
          navigate(openPath(f));
        } catch (e) { toast(e.message, 'error'); }
      }} />}
      {dialog?.type === 'rename-many' && <RenameMany files={dialog.files} onClose={() => setDialog(null)} onDone={(changed) => {
        setDialog(null); setChecked(new Set()); load();
        // Undo puts each name back as it was.
        const back = Object.fromEntries(changed.map((x) => [x.id, x.from]));
        toast(`Renamed ${changed.length}`, 'info', { action: { label: 'Undo', onClick: () => post('/files/rename-many', { names: back }).then(() => { toast('Names put back'); load(); }).catch((e) => toast(e.message, 'error')) } });
      }} />}
      {dialog?.type === 'bulk-label' && <PromptModal title={`Label ${dialog.files.length} item${dialog.files.length === 1 ? '' : 's'}`} label="Label" confirm="Add label"
        message={myLabels.length ? `Yours so far: ${myLabels.map((l) => l.name).join(', ')}. Their other labels stay.` : 'A label of your own, to find them again from the left.'}
        onClose={() => setDialog(null)} onSubmit={async (label) => {
          const r = await post('/files/labels/add', { ids: dialog.files.map((f) => f.id), label });
          toast(`Labelled ${dialog.files.length} “${r.label}”`);
          setChecked(new Set()); await loadLabels(); load();
        }} />}
      {dialog?.type === 'label-rename' && <PromptModal title="Rename label" label="Label name" initial={dialog.label} confirm="Rename" message="On all your files with it. A name you already use joins the two."
        onClose={() => setDialog(null)} onSubmit={async (to) => {
          const r = await post('/files/labels/rename', { from: dialog.label, to });
          await loadLabels();
          if (route.view === 'label' && route.label === dialog.label) navigate(`/drive/label/${encodeURIComponent(r.label)}`, { replace: true }); else load();
        }} />}
      {dialog?.type === 'label-delete' && <ConfirmModal title={`Delete the label “${dialog.label}”?`} confirm="Delete label" message="It comes off all your files. The files stay where they are."
        onClose={() => setDialog(null)} onConfirm={async () => {
          await post('/files/labels/delete', { label: dialog.label });
          await loadLabels();
          if (route.view === 'label' && route.label === dialog.label) navigate('/drive', { replace: true }); else load();
        }} />}
      {dialog?.type === 'labels' && <LabelsDialog file={dialog.file} all={myLabels.map((l) => l.name)} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); loadLabels(); }} />}
      {dialog?.type === 'details' && <DetailsDialog file={dialog.file} onClose={() => setDialog(null)} onChanged={load} />}
      {dialog?.type === 'versions' && <VersionsDialog file={dialog.file} onClose={() => setDialog(null)} onChanged={load} />}
      <input ref={versionInput} type="file" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { uploadNewVersion(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

const dayInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const endOfDay = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); };

/** The owner's switch: may people who can only view or comment download, print and copy it? */
function NoDownload({ file }) {
  const toast = useToast();
  const [off, setOff] = useState(!!file.no_download);
  const flip = async (allow) => {
    setOff(!allow);
    try { await patch(`/files/${file.id}`, { no_download: !allow }); toast(allow ? 'Viewers and commenters can download, print and copy it' : 'Viewers and commenters can only look at it now'); }
    catch (e) { setOff(allow); toast(e.message, 'error'); }
  };
  return (
    <label className="check small" style={{ marginTop: 8 }}>
      <input type="checkbox" checked={!off} onChange={(e) => flip(e.target.checked)} /> Viewers and commenters can download, print and copy
    </label>
  );
}

/** For the PDF tools: 'pdf', 'png' or 'jpg' for files they take (and may be copied), else null. */
function pdfPart(f) {
  if (f.kind !== 'file' || viewOnly(f)) return null;
  const n = String(f.name || '').toLowerCase(), m = String(f.mime || '').toLowerCase();
  return m === 'application/pdf' || n.endsWith('.pdf') ? 'pdf' : m === 'image/png' || n.endsWith('.png') ? 'png' : m === 'image/jpeg' || /\.jpe?g$/.test(n) ? 'jpg' : null;
}

/** Combine PDFs and pictures into one new PDF, in the order chosen here. */
function PdfCombineDialog({ files, onClose, onDone }) {
  const toast = useToast();
  const [order, setOrder] = useState(files);
  const [name, setName] = useState(`${files[0].name.replace(/\.[a-z0-9]+$/i, '')} (combined)`);
  const [busy, setBusy] = useState(false);
  const move = (i, d) => { const next = [...order]; [next[i], next[i + d]] = [next[i + d], next[i]]; setOrder(next); };
  const go = async () => {
    setBusy(true);
    try { const r = await post('/files/pdf/combine', { ids: order.map((f) => f.id), name }); toast(`Made “${r.name}”`); onDone(r); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Combine into one PDF" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={go}>{busy ? 'Combining…' : 'Combine'}</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>PDFs keep their pages; each picture gets a page of its own. The new PDF goes next to the first file; these stay as they are.</p>
        <ol className="pdf-order" aria-label="Order">
          {order.map((f, i) => (
            <li key={f.id} className="row">
              <span className="grow ellipsis">{f.name}</span>
              <button type="button" className="icon-btn" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="icon-btn" aria-label={`Move ${f.name} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>↓</button>
            </li>
          ))}
        </ol>
        <label className="field"><span>Name of the new PDF</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
      </div>
    </Modal>
  );
}

/** Take some pages of a PDF out into a new one (turned, if you like). */
function PdfExtractDialog({ file, onClose, onDone }) {
  const toast = useToast();
  const [count, setCount] = useState(null);
  const [pages, setPages] = useState('');
  const [rotate, setRotate] = useState('0');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get(`/files/${file.id}/pdf/pages`).then((r) => { setCount(r.pages); setPages(r.pages > 1 ? `1-${r.pages}` : '1'); }).catch((e) => { toast(e.message, 'error'); onClose(); }); }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    setBusy(true);
    try { const r = await post(`/files/${file.id}/pdf/extract`, { pages, rotate: Number(rotate), ...(name.trim() && { name: name.trim() }) }); toast(`Made “${r.name}”`); onDone(r); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title={`Extract pages from “${file.name}”`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || count === null} onClick={go}>{busy ? 'Making…' : 'Make new PDF'}</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>{count === null ? 'Counting pages…' : `It has ${count} page${count === 1 ? '' : 's'}.`} The pages you list go into a new PDF in that order, next to this one, which stays as it is.</p>
        <label className="field"><span>Pages (like 1-3, 5, 8-)</span><input value={pages} onChange={(e) => setPages(e.target.value)} /></label>
        <label className="field"><span>Turn them</span><select value={rotate} onChange={(e) => setRotate(e.target.value)}><option value="0">No</option><option value="90">A quarter turn clockwise</option><option value="180">Upside down</option><option value="270">A quarter turn anticlockwise</option></select></label>
        <label className="field"><span>Name of the new PDF (optional)</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={`${file.name.replace(/\.pdf$/i, '')} (pages …)`} /></label>
      </div>
    </Modal>
  );
}

export function ShareDialog({ file, onClose }) {
  const toast = useToast();
  const [dataCheck, checkData] = useDataCheck();
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [shares, setShares] = useState(null);
  const [address, setAddress] = useState('');
  const [role, setRole] = useState('viewer');
  const [error, setError] = useState('');
  const [company, setCompany] = useState(file.org_role || '');
  const setCompanyRole = async (next) => {
    const was = company;
    setCompany(next);
    try { await put(`/files/${file.id}/company`, { role: next || null }); toast(next ? `Everyone at ${user.org_name} can ${next === 'editor' ? 'edit' : next === 'commenter' ? 'comment on' : 'view'} it` : `No longer shared with everyone at ${user.org_name}`); }
    catch (e) { setCompany(was); toast(e.message, 'error'); }
  };

  const [groups, setGroups] = useState([]); // the company's groups
  const [fileGroups, setFileGroups] = useState(null); // the ones this is shared with
  const mine = file.owner_id === user.id;
  // A shared drive: those who can edit it manage its members too.
  const manages = mine || (!!file.is_drive && !file.parent_id && file.role === 'editor');
  useEffect(() => {
    get('/users/directory').then(setPeople);
    get(`/files/${file.id}/shares`).then(setShares);
    get(`/files/${file.id}/groups`).then(setFileGroups).catch(() => setFileGroups([]));
    get('/groups').then(setGroups).catch(() => {});
  }, [file.id]);

  const taken = (id) => id === user.id || id === file.owner_id || shares?.some((s) => s.user_id === id);
  const suggestions = people.filter((p) => !taken(p.id));

  // Colleagues come from the directory; anyone else is looked up by exact address.
  async function add(e) {
    e.preventDefault();
    setError('');
    const a = address.trim().toLowerCase();
    if (!a) return;
    try {
      const colleague = people.find((p) => p.username === a);
      const person = colleague ? { ...colleague, org_name: user.org_name, external: false }
        : { ...(await get(`/users/lookup?email=${encodeURIComponent(a)}`)), external: true };
      if (taken(person.id)) return setError('That person already has access');
      setShares([...shares, { user_id: person.id, name: person.name, username: person.username, org_name: person.org_name, external: person.external, role }]);
      setAddress('');
    } catch (err) { setError(err.message); }
  }

  async function save() {
    try {
      const done = await checkData((more) => put(`/files/${file.id}/shares`, { shares: shares.map(({ user_id, role, expires_at }) => ({ user_id, role, expires_at: expires_at || null })), ...more }));
      if (!done) return;
      if (manages && fileGroups) await put(`/files/${file.id}/groups`, { groups: fileGroups.map(({ group_id, role }) => ({ group_id, role })) });
      toast('Sharing updated');
      onClose();
    } catch (e) { toast(e.message, 'error'); }
  }

  const external = shares?.filter((s) => s.external).length || 0;

  return (
    <Modal title={file.is_drive && !file.parent_id ? `Members of “${file.name}”` : `Share “${file.name}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!shares}>Save</button></>}>
      {dataCheck}
      {file.is_drive && !file.parent_id && <p className="muted small" style={{ marginTop: 0 }}>Everyone added sees everything in this shared drive. Editors can also add files, rename the drive and manage its members; what people add stays here when they leave the company.</p>}
      <form className="row" onSubmit={add}>
        <input className="grow" list="share-people" type="email" value={address} placeholder="Add people by email address"
          aria-label="Email address" autoFocus onChange={(e) => { setAddress(e.target.value); setError(''); }} />
        <datalist id="share-people">
          {suggestions.map((p) => <option key={p.id} value={p.username}>{p.name}</option>)}
        </datalist>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Access">
          <option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option>
        </select>
        <button className="btn" disabled={!address.trim()}>Add</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {!user.allow_external && <p className="muted small">Your company only allows sharing with colleagues.</p>}
      <ul className="share-list">
        <li><Avatar name={file.owner_name} size={28} userId={file.owner_id} /><span className="grow">{file.owner_name}</span><span className="muted">Owner</span></li>
        {manages && (
          <li className="share-company">
            <span className="avatar company-avatar" aria-hidden="true"><Icon name="people" size={16} /></span>
            <span className="grow">Everyone at {user.org_name} <span className="muted small">(also people who join later)</span></span>
            <select value={company} aria-label={`Access for everyone at ${user.org_name}`} onChange={(e) => setCompanyRole(e.target.value)}>
              <option value="">No access</option><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option>
            </select>
            <span style={{ width: 32 }} />
          </li>
        )}
        {fileGroups?.map((g) => (
          <li key={g.group_id} className="share-group">
            <span className="avatar company-avatar" aria-hidden="true"><Icon name="people" size={16} /></span>
            <span className="grow ellipsis">{g.name} <span className="muted small">group · {g.members === 1 ? '1 person' : `${g.members} people`}</span></span>
            <select value={g.role} disabled={!manages} aria-label={`Access for the group ${g.name}`} onChange={(e) => setFileGroups(fileGroups.map((x) => (x.group_id === g.group_id ? { ...x, role: e.target.value } : x)))}>
              <option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option>
            </select>
            {manages ? <button className="icon-btn" aria-label={`Remove the group ${g.name}`} onClick={() => setFileGroups(fileGroups.filter((x) => x.group_id !== g.group_id))}><Icon name="close" size={18} /></button> : <span style={{ width: 32 }} />}
          </li>
        ))}
        {manages && fileGroups && groups.some((g) => !fileGroups.some((x) => x.group_id === g.id)) && (
          <li className="share-group-add">
            <span className="avatar company-avatar" aria-hidden="true"><Icon name="people" size={16} /></span>
            <select className="grow" value="" aria-label="Share with a group" onChange={(e) => {
              const g = groups.find((x) => x.id === e.target.value);
              if (g) setFileGroups([...fileGroups, { group_id: g.id, name: g.name, members: g.members.length, role }]);
            }}>
              <option value="">Share with a group…</option>
              {groups.filter((g) => !fileGroups.some((x) => x.group_id === g.id)).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}
            </select>
          </li>
        )}
        {shares?.map((s) => (
          <li key={s.user_id}>
            <Avatar name={s.name} size={28} userId={s.user_id} />
            <span className="grow ellipsis">{s.name} <span className="muted small">{s.username}</span>
              {s.external && <span className="pill ext">External · {s.org_name}</span>}</span>
            <select value={s.role} aria-label={`Access for ${s.name}`} onChange={(e) => setShares(shares.map((x) => (x.user_id === s.user_id ? { ...x, role: e.target.value } : x)))}>
              <option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option>
            </select>
            {/* Until a day (optional): access ends at the end of it. */}
            <input type="date" className="share-until" aria-label={`Access for ${s.name} ends`} title="Access ends after this day (empty: no end)"
              min={dayInput(Date.now())} max={dayInput(Date.now() + 365 * 864e5)} value={s.expires_at ? dayInput(s.expires_at) : ''}
              onChange={(e) => setShares(shares.map((x) => (x.user_id === s.user_id ? { ...x, expires_at: e.target.value ? endOfDay(e.target.value) : null } : x)))} />
            <button className="icon-btn" aria-label={`Remove ${s.name}`} onClick={() => setShares(shares.filter((x) => x.user_id !== s.user_id))}><Icon name="close" size={18} /></button>
          </li>
        ))}
      </ul>
      {mine && file.kind !== 'folder' && <NoDownload file={file} />}
      {shares?.length > 0 && <p className="muted small">A date beside someone ends their access after that day; leave it empty for no end.</p>}
      {external > 0 && <p className="muted small">{external === 1 ? '1 person' : `${external} people`} outside {user.org_name} can open this.</p>}
      {file.kind === 'folder' && <p className="muted small">People get the same access to everything inside this folder.</p>}
      {(file.kind === 'file' || file.kind === 'folder') && <LinkSharing file={file} />}
    </Modal>
  );
}

const EXPIRY = [['', 'Never expires'], ['1', 'Expires in 1 day'], ['7', 'Expires in 7 days'], ['30', 'Expires in 30 days']];
export const linkUrl = (token) => `${window.location.origin}/s/${token}`;

/** Links for people without an account: create (expiry, password), copy, remove. Changes apply at once. */
function LinkSharing({ file }) {
  const toast = useToast();
  const [dataCheck, checkData] = useDataCheck();
  const { user } = useAuth();
  const [links, setLinks] = useState(null);
  const [days, setDays] = useState('7');
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [uploadOnly, setUploadOnly] = useState(false); // a file request: people send files in, and see nothing
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user.allow_links) get(`/links?file=${file.id}`).then(setLinks).catch(() => setLinks([])); }, [file.id, user.allow_links]);

  if (!user.allow_links) return <section className="link-share"><h3>Link sharing</h3><p className="muted small">Your company has turned off links for people without an account.</p></section>;

  async function create() {
    setBusy(true);
    try {
      const l = await checkData((more) => post('/links', { file_id: file.id, expires_at: days ? Date.now() + Number(days) * 864e5 : null, ...(usePassword && { password }), ...(uploadOnly && { mode: 'upload' }), ...more }));
      if (!l) { setBusy(false); return; }
      setLinks([...links, l]);
      setPassword(''); setUsePassword(false); setUploadOnly(false);
      await copy(l, l.mode === 'upload' ? 'File request created and copied' : 'Link created and copied');
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  }
  async function copy(l, message = 'Link copied') {
    try { await navigator.clipboard.writeText(linkUrl(l.token)); toast(message); }
    catch { toast('Select the link and copy it', 'error'); }
  }
  async function remove(l) {
    try { await del(`/links/${l.id}`); setLinks(links.filter((x) => x.id !== l.id)); toast('Link removed: it no longer works'); }
    catch (e) { toast(e.message, 'error'); }
  }

  const what = file.kind === 'folder' ? 'this folder and everything in it' : 'this file';
  return (
    <section className="link-share" aria-label="Link sharing">
      {dataCheck}
      <h3>Link sharing</h3>
      <p className="muted small">Anyone with a link can view and download {what}, without an account.{file.kind === 'folder' && ' A file request link instead lets people send files into it, without seeing what’s there.'}</p>
      <ul className="share-list">
        {links?.map((l) => (
          <li key={l.id} className={l.expired ? 'expired' : ''}>
            <Icon name={l.mode === 'upload' ? 'upload' : 'link'} size={20} />
            <div className="grow" style={{ minWidth: 0 }}>
              <input className="link-url" readOnly value={linkUrl(l.token)} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <span className="muted small">
                {[l.mode === 'upload' && 'File request (upload only)', l.expired ? 'Expired' : l.expires_at ? `Until ${formatDate(l.expires_at)}` : 'No expiry',
                  l.has_password && 'Password', l.opens ? `Opened ${l.opens === 1 ? 'once' : `${l.opens} times`}` : 'Not opened yet'].filter(Boolean).join(' · ')}
              </span>
            </div>
            {!l.expired && <button type="button" className="icon-btn" aria-label="Copy link" title="Copy link" onClick={() => copy(l)}><Icon name="copy" size={18} /></button>}
            <button type="button" className="icon-btn" aria-label="Remove link" title="Remove link" onClick={() => remove(l)}><Icon name="close" size={18} /></button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Link expiry">
          {EXPIRY.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} /> Password</label>
        {file.kind === 'folder' && <label className="check"><input type="checkbox" checked={uploadOnly} onChange={(e) => setUploadOnly(e.target.checked)} /> File request (upload only)</label>}
        {usePassword && <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" aria-label="Link password" autoComplete="off" />}
        <button type="button" className="btn" onClick={create} disabled={!links || busy || (usePassword && password.length < 6)}><Icon name={uploadOnly ? 'upload' : 'link'} size={18} /> {uploadOnly ? 'Create file request' : 'Create link'}</button>
      </div>
      {usePassword && <p className="muted small">Send the password separately from the link, for example by phone.</p>}
    </section>
  );
}

/** Move files into a folder, or (shortcut) add a shortcut to one there. */
function MoveDialog({ files, onClose, onMoved, onCopy, shortcut = false, copy = false }) {
  const toast = useToast();
  const [cur, setCur] = useState(null); // null = My Drive root
  const [path, setPath] = useState([]);
  const [folders, setFolders] = useState([]);

  useEffect(() => {
    get(`/files?view=mine&noshortcuts=1${cur ? `&parent=${cur}` : ''}`).then((l) => setFolders(l.filter((f) => f.kind === 'folder' && !files.some((x) => x.id === f.id))));
    if (cur) get(`/files/${cur}/path`).then(setPath); else setPath([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  async function move() {
    if (copy) { onClose(); onCopy(cur); return; }
    if (shortcut) {
      try { const r = await post(`/files/${files[0].id}/shortcut`, { parent_id: cur }); toast(r.existing ? 'There’s already a shortcut to it there' : 'Shortcut added'); onMoved(); onClose(); } catch (e) { toast(e.message, 'error'); }
      return;
    }
    const moved = []; // where each was, for Undo
    for (const f of files) { try { await patch(`/files/${f.id}`, { parent_id: cur }); moved.push({ id: f.id, parent_id: f.parent_id ?? null }); } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); } }
    onMoved(moved); onClose();
  }

  return (
    <Modal title={copy ? (files.length === 1 ? `Copy “${files[0].name}” to…` : `Copy ${files.length} items to…`) : shortcut ? `Add a shortcut to “${files[0].name}”` : files.length === 1 ? `Move “${files[0].name}”` : `Move ${files.length} items`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={move}>{copy ? 'Copy here' : shortcut ? 'Add shortcut here' : 'Move here'}</button></>}>
      {copy && <p className="muted small" style={{ marginTop: 0 }}>The original stays where it is. A copy keeps its name, unless it goes in the same folder (then it’s “Copy of …”).</p>}
      {shortcut && <p className="muted small" style={{ marginTop: 0 }}>It stays where it is; the shortcut opens it from this folder too. People still need access to it to open it.</p>}
      <nav className="crumbs small">
        <button className="crumb" onClick={() => setCur(null)}>My Drive</button>
        {path.map((c) => <span key={c.id} className="crumb-wrap"><Icon name="right" size={16} /><button className="crumb" onClick={() => setCur(c.id)}>{c.name}</button></span>)}
      </nav>
      <ul className="pick-list">
        {folders.length === 0 && <li className="muted">No folders here</li>}
        {folders.map((f) => <li key={f.id}><button onClick={() => setCur(f.id)}><Icon name="folder" className="ft ft-folder" />{f.name}<Icon name="right" size={18} /></button></li>)}
      </ul>
    </Modal>
  );
}

/** A shortcut in the list: what it points to, marked with an arrow; it can be opened but not moved or picked. */
function ShortcutRow({ f, me, selected, onSelect, onOpen, menu }) {
  return (
    <tr className={`shortcut-row ${selected ? 'selected' : ''} ${f.broken ? 'broken' : ''}`} tabIndex={0} onClick={onSelect} onDoubleClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <td className="check-col" />
      <td className="name"><span className="shortcut-icon"><Icon name={f.broken ? 'file' : fileIcon(f)} className={`ft ft-${fileIcon(f)}`} style={f.color ? { color: f.color } : undefined} /><span className="shortcut-arrow" aria-hidden="true">↪</span></span>
        <span className="name-text">{f.name}<span className="sr-only"> (shortcut)</span></span></td>
      <td className="hide-sm muted">{f.broken ? '' : f.owner_id === me ? 'me' : f.owner_name}</td>
      <td className="hide-sm muted">{f.broken ? '' : formatDate(f.updated_at)}</td>
      <td className="hide-sm muted">—</td>
      <td className="actions"><Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${f.name} (shortcut)`} {...p}><Icon name="more" /></button>} items={menu} /></td>
    </tr>
  );
}

/** Office files that can open as Docs, Sheets or Slides. */
export function officeAs(f) {
  if (f.kind !== 'file') return null;
  const ext = (/\.([a-z]+)$/i.exec(f.name) || [])[1]?.toLowerCase();
  return { docx: { what: 'document', icon: 'doc' }, odt: { what: 'document', icon: 'doc' }, md: { what: 'document', icon: 'doc' }, markdown: { what: 'document', icon: 'doc' }, xlsx: { what: 'spreadsheet', icon: 'sheet' }, ods: { what: 'spreadsheet', icon: 'sheet' }, pptx: { what: 'presentation', icon: 'slides' }, odp: { what: 'presentation', icon: 'slides' } }[ext] || null;
}

function Preview({ file, onClose, onOpenAs, comment = null }) {
  const src = `/api/files/${file.id}/raw`;
  const m = file.mime || '';
  // Comments: on the whole file, or (pictures) on a spot, shown as a numbered pin.
  const { threads, fresh, seenAt, markSeen } = useComments(file.id);
  const [panel, setPanel] = useState(!!comment);
  const [active, setActive] = useState(comment);
  const [pending, setPending] = useState(null);
  const [pinning, setPinning] = useState(false);
  const canEdit = file.role !== 'viewer';
  const isPicture = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m);
  const isZip = /\.zip$/i.test(file.name);
  const navigate = useNavigate();
  const toast = useToast();
  const [unpacking, setUnpacking] = useState(false);
  const extract = async () => {
    setUnpacking(true);
    try {
      const r = await post(`/files/${file.id}/extract`);
      onClose();
      toast(`Unpacked ${r.files} file${r.files === 1 ? '' : 's'} into “${r.folder.name}”`, 'info', { action: { label: 'Show', onClick: () => navigate(`/drive/folder/${r.folder.id}`) } });
    } catch (e) { toast(e.message, 'error'); setUnpacking(false); }
  };
  const pins = threads.filter((t) => !t.resolved && t.anchor && t.anchor.x !== undefined);
  const newComment = (anchor, label) => { setPanel(true); setPending({ anchor, label, onCreated: () => setPending(null), onCancel: () => setPending(null) }); };
  const pinAt = (e) => {
    if (!pinning) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPinning(false);
    newComment({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 }, 'this spot');
  };
  const labelOf = (t) => (t.anchor?.x !== undefined ? `Spot ${pins.findIndex((p) => p.id === t.id) + 1 || ''}`.trim() : 'The whole file');
  let body;
  if (isPicture) body = (
    <div className={`preview-pic ${pinning ? 'pinning' : ''}`} onClick={pinAt}>
      <img src={src} alt={file.name} className="preview-media" />
      {pins.map((t, k) => <button key={t.id} type="button" className={`comment-pin ${t.id === active ? 'on' : ''}`} style={{ left: `${t.anchor.x}%`, top: `${t.anchor.y}%` }} aria-label={`Comment ${k + 1}`} onClick={(e) => { e.stopPropagation(); setPanel(true); setActive(t.id); }}>{k + 1}</button>)}
      {pending?.anchor?.x !== undefined && <span className="comment-pin new" style={{ left: `${pending.anchor.x}%`, top: `${pending.anchor.y}%` }} aria-hidden="true">+</span>}
    </div>
  );
  else if (/^video\/(mp4|webm)$/.test(m)) body = <video src={src} controls className="preview-media" />;
  else if (m.startsWith('audio/')) body = <audio src={src} controls />;
  else if (m === 'application/pdf' || m.startsWith('text/')) body = <iframe src={src} title={file.name} className="preview-frame" />;
  else if (officeAs(file)) body = <OfficePreview url={`/files/${file.id}/preview`} />;
  else if (isZip) body = <ZipContents url={`/files/${file.id}/zip`} />;
  else if (/\.eml$/i.test(file.name)) body = <EmlContents url={`/files/${file.id}/eml`} />;
  else body = <Empty icon="file" title="No preview available">Download the file to open it on your device.</Empty>;
  return (
    <Modal wide title={file.name} onClose={onClose} footer={<>
      <button type="button" className={`btn ${panel ? 'primary' : ''}`} aria-pressed={panel} onClick={() => setPanel(!panel)}><Icon name="chat" size={18} /> Comments{threads.filter((t) => !t.resolved).length ? ` (${threads.filter((t) => !t.resolved).length})` : ''}<NewCount n={fresh.length} /></button>
      {isZip && !viewOnly(file) && <button type="button" className="btn primary" disabled={unpacking} title="Unpack it into a folder of the same name next to it" onClick={extract}><Icon name="folder" size={18} /> {unpacking ? 'Unpacking…' : 'Extract here'}</button>}
      {officeAs(file) && <button type="button" className="btn primary" title="Workspace makes an editable copy next to it; the original stays as it is" onClick={onOpenAs}><Icon name={officeAs(file).icon} size={18} /> Open as {officeAs(file).what}</button>}
      {viewOnly(file) ? <span className="muted small">View only: downloading is turned off</span> : <a className={`btn ${officeAs(file) || isZip ? '' : 'primary'}`} href={`${src}?download`}><Icon name="download" size={18} /> Download</a>}
    </>}>
      <div className={`preview-with-comments ${panel ? 'open' : ''}`}>
        <div className="preview">{body}</div>
        {panel && (
          <div className="preview-comments stack-tight">
            {canEdit && !pending && (
              <div className="row wrap">
                <button type="button" className="btn small" onClick={() => newComment({}, 'the whole file')}>Comment on the file</button>
                {isPicture && <button type="button" className={`btn small ${pinning ? 'primary' : ''}`} aria-pressed={pinning} onClick={() => setPinning(!pinning)}>{pinning ? 'Click a spot on the picture…' : 'Comment on a spot'}</button>}
              </div>
            )}
            <CommentsPanel fileId={file.id} fileRole={file.role} seenAt={seenAt} onSeen={markSeen} threads={threads} canEdit={canEdit} active={active} setActive={setActive} pending={pending}
              onShow={(t) => setActive(t.id)} labelOf={labelOf} onClose={() => { setPending(null); setPanel(false); }} />
          </div>
        )}
      </div>
      <p className="muted small">{formatBytes(file.size)} · modified {formatDate(file.updated_at)}</p>
    </Modal>
  );
}

/** Earlier versions of a file: download or look at them, bring one back, or delete it. */
const FOLDER_COLOURS = ['#5f6368', '#1a73e8', '#0b8043', '#d93025', '#e37400', '#f6bf26', '#8e24aa', '#00796b'];

/** A file's details: what it is, whose, when it changed, who has it, a description, and (folders) a colour. */
/** How big a folder is (everything in it, sub-folders too), and the biggest files in it. */
function FolderSize({ id }) {
  const [s, setS] = useState(null);
  useEffect(() => { get(`/files/${id}/size`).then(setS).catch(() => setS({ error: true })); }, [id]);
  if (!s) return '…';
  if (s.error) return '—';
  const n = (k, one) => `${k.toLocaleString()} ${one}${k === 1 ? '' : 's'}`;
  return (
    <>
      <span>{formatBytes(s.size)} · {n(s.files, 'file')}{s.folders ? `, ${n(s.folders, 'folder')}` : ''}</span>
      {s.biggest.length > 1 && (
        <details className="folder-biggest"><summary className="small">Biggest files</summary>
          <ul className="small">{s.biggest.map((b) => <li key={b.id}><a href={openUrl(b)} target={b.kind === 'file' ? '_blank' : undefined} rel="noopener noreferrer">{b.name}</a> <span className="muted">{formatBytes(b.size)}</span></li>)}</ul>
        </details>
      )}
    </>
  );
}

/** Your labels on a file or folder: tick the ones you use, or type a new one. Only you see them. */
function LabelsDialog({ file, all, onClose, onSaved }) {
  const toast = useToast();
  const [chosen, setChosen] = useState(() => new Set(file.labels || []));
  const [names, setNames] = useState(() => [...new Set([...all, ...(file.labels || [])])].sort((a, b) => a.localeCompare(b)));
  const [fresh, setFresh] = useState('');
  const add = (e) => {
    e.preventDefault();
    const t = fresh.replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!t) return;
    const known = names.find((n) => n.toLowerCase() === t.toLowerCase()) || t;
    if (!names.includes(known)) setNames((n) => [...n, known].sort((a, b) => a.localeCompare(b)));
    setChosen((c) => new Set([...c, known]));
    setFresh('');
  };
  const save = async () => {
    try { await put(`/files/${file.id}/labels`, { labels: [...chosen] }); onSaved(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Labels: ${file.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Your own labels, to find things again from the left. Only you see them.</p>
      <div className="stack-tight">
        {names.map((n) => <label key={n} className="row" style={{ gap: 6 }}><input type="checkbox" checked={chosen.has(n)} onChange={() => setChosen((c) => { const x = new Set(c); if (x.has(n)) x.delete(n); else x.add(n); return x; })} /> {n}</label>)}
      </div>
      <form className="row" style={{ gap: 6, marginTop: 10 }} onSubmit={add}>
        <input className="grow" aria-label="New label" placeholder="New label" maxLength={30} value={fresh} onChange={(e) => setFresh(e.target.value)} />
        <button className="btn small" disabled={!fresh.trim()}>Add</button>
      </form>
    </Modal>
  );
}

function DetailsDialog({ file, onClose, onChanged }) {
  const toast = useToast();
  const [f, setF] = useState(file);
  const [desc, setDesc] = useState(file.description || '');
  const [shares, setShares] = useState(null);
  const canEdit = f.role === 'owner' || f.role === 'editor';
  useEffect(() => { if (f.role === 'owner') get(`/files/${f.id}/shares`).then(setShares).catch(() => setShares([])); }, [f.id, f.role]);
  const save = async (body, msg) => { try { const next = await patch(`/files/${f.id}`, body); setF({ ...f, ...next }); onChanged(); if (msg) toast(msg); } catch (e) { toast(e.message, 'error'); } };
  const kind = { folder: 'Folder', doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation' }[f.kind] || f.mime || 'File';
  const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Modal title="Details" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <div className="row" style={{ gap: 10 }}><Icon name={fileIcon(f)} size={32} className={`ft ft-${fileIcon(f)}`} style={f.color ? { color: f.color } : undefined} /><strong className="grow" style={{ overflowWrap: 'anywhere' }}>{f.name}</strong></div>
        <dl className="details-list">
          <dt>Type</dt><dd>{kind}</dd>
          {f.kind !== 'folder' ? <><dt>Size</dt><dd>{formatBytes(f.size)}</dd></> : <><dt>Size</dt><dd><FolderSize id={f.id} /></dd></>}
          <dt>Owner</dt><dd>{f.owner_name}{f.role === 'owner' ? ' (you)' : ''}</dd>
          <dt>Modified</dt><dd>{when(f.updated_at)}{f.updated_by_name ? ` by ${f.updated_by_name}` : ''}</dd>
          <dt>Created</dt><dd>{when(f.created_at)}</dd>
          {f.kind === 'doc' && <><dt>Length</dt><dd><DocLength fileId={f.id} /></dd></>}
          <dt>Access</dt><dd>{f.role === 'owner' ? (shares === null ? '…' : shares.length ? shares.map((s) => `${s.name} (${s.role === 'editor' ? 'can edit' : s.role === 'commenter' ? 'can comment' : 'can view'})`).join(', ') : 'Only you') : `You can ${f.role === 'editor' ? 'edit' : 'view'}`}</dd>
        </dl>
        <label className="field"><span>Description</span>
          <textarea rows={3} maxLength={2000} value={desc} disabled={!canEdit} placeholder={canEdit ? 'What it is, for whom… (search finds it)' : ''} onChange={(e) => setDesc(e.target.value)}
            onBlur={() => { if (desc.trim() !== (f.description || '')) save({ description: desc }, 'Description saved'); }} />
        </label>
        {canEdit && f.kind !== 'folder' && <Viewers fileId={f.id} />}
        <Activity fileId={f.id} />
        {f.kind === 'folder' && canEdit && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="muted small">Folder colour</span>
            <div className="label-colors" role="radiogroup" aria-label="Folder colour">
              {FOLDER_COLOURS.map((c) => <button key={c} type="button" role="radio" aria-checked={(f.color || '#5f6368') === c} aria-label={c} className={(f.color || '#5f6368') === c ? 'on' : ''} style={{ background: c }} onClick={() => save({ color: c === '#5f6368' ? null : c })} />)}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Who has opened the file (owners and editors see this), most recent first. */
function Viewers({ fileId }) {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  useEffect(() => { get(`/files/${fileId}/viewers`).then((r) => setList(r.off ? null : r.viewers)).catch(() => setList(null)); }, [fileId]);
  if (!list) return null; // loading, or turned off for the company
  const others = list.filter((v) => v.id !== user.id); // not you
  return (
    <section className="stack-tight" aria-label="Who has seen it">
      <span className="muted small">Who has seen it</span>
      {others.length ? (
        <ul className="viewers-list">
          {others.map((v) => <li key={v.id} className="row"><Avatar name={v.name} size={22} userId={v.id} /><span className="grow">{v.name}</span>
            <span className="muted small">{formatDate(v.last_at)}{v.times > 1 ? ` · ${v.times} times` : ''}</span></li>)}
        </ul>
      ) : <p className="muted small" style={{ margin: 0 }}>Nobody has opened it yet.</p>}
    </section>
  );
}

/** What was dropped: files, and the files inside dropped folders with the folders they were in. */
async function droppedFiles(dt) {
  const entries = [...dt.items || []].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((x) => x.isDirectory)) return [...dt.files];
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) { out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), dir }); return; }
    const reader = entry.createReader();
    for (;;) { // a folder is read a batch at a time
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, [...dir, entry.name]);
    }
  };
  for (const entry of entries) await walk(entry, []);
  return out;
}

/** People asking to see or edit your files: share as asked (or view only), or decline. */
function AccessRequests({ list, onClose, onChanged }) {
  const toast = useToast();
  const [roles, setRoles] = useState({});
  const answer = async (r, approve) => {
    try {
      const role = roles[r.id] || r.role;
      await post(`/files/access-requests/${r.id}`, { approve, role });
      toast(approve ? `${r.user_name} can now ${role === 'editor' ? 'edit' : 'view'} ${r.file_name}` : `Declined ${r.user_name}`);
      onChanged();
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal wide title="Access requests" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!list.length ? <p className="muted">Nobody is waiting.</p> : (
        <ul className="access-requests">
          {list.map((r) => (
            <li key={r.id}>
              <div className="grow">
                <div><strong>{r.user_name}</strong> <span className="muted small">{r.user_email}</span> asks to {r.role === 'editor' ? 'edit' : 'view'} <strong>{r.file_name}</strong></div>
                {r.message && <div className="muted small">“{r.message}”</div>}
              </div>
              <select value={roles[r.id] || r.role} onChange={(e) => setRoles({ ...roles, [r.id]: e.target.value })} aria-label={`Access for ${r.user_name}`}>
                <option value="viewer">Can view</option><option value="editor">Can edit</option>
              </select>
              <button type="button" className="btn small primary" onClick={() => answer(r, true)}>Share</button>
              <button type="button" className="btn small" onClick={() => answer(r, false)}>Decline</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** New from a template: your own, your company's, and the built-in ones. */
function TemplatesDialog({ onClose, onPick }) {
  const [company, setCompany] = useState(null);
  useEffect(() => { get('/files/templates').then(setCompany).catch(() => setCompany([])); }, []);
  const card = (t, key) => (
    <button key={key} type="button" className="template-card" onClick={() => onPick(t)} aria-label={`${t.name} (${{ doc: 'document', sheet: 'spreadsheet', slides: 'presentation' }[t.kind]})`}>
      <Icon name={t.kind} size={28} className={`ft ft-${t.kind}`} />
      <strong>{t.name}</strong>
      <span className="muted small">{t.blurb || t.description || (t.owner_name ? `From ${t.owner_name}` : '')}</span>
    </button>
  );
  return (
    <Modal wide title="New from a template" onClose={onClose} footer={<button className="btn" onClick={onClose}>Cancel</button>}>
      <div className="stack">
        {company?.some((t) => t.mine) && <>
          <h3 className="template-head">My templates</h3>
          <div className="template-grid" aria-label="My templates">{company.filter((t) => t.mine).map((t) => card({ ...t, owner_name: null, blurb: t.description || 'Yours' }, t.id))}</div>
        </>}
        {company?.some((t) => !t.mine) && <>
          <h3 className="template-head">Your company</h3>
          <div className="template-grid">{company.filter((t) => !t.mine).map((t) => card(t, t.id))}</div>
        </>}
        <h3 className="template-head">Ready-made</h3>
        <div className="template-grid">{BUILT_IN.map((t) => card({ ...t, builtIn: true }, t.key))}</div>
      </div>
    </Modal>
  );
}

/** Where your space goes, and the biggest things to clear. */
function StorageDialog({ onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState(null);
  const load = () => get('/files/storage').then(setS).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn, msg) => async () => { try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); load(); onChanged(); } catch (e) { toast(e.message, 'error'); } };
  if (!s) return null;
  const total = s.files + s.versions + s.trash;
  return (
    <Modal title="Storage" onClose={onClose}>
      <div className="stack">
        <table className="storage-sum">
          <tbody>
            <tr><th>Your files</th><td>{formatBytes(s.files)}</td></tr>
            <tr><th>Older versions</th><td>{formatBytes(s.versions)}</td></tr>
            <tr><th>In the trash</th><td>{formatBytes(s.trash)}{s.trash > 0 && <> <button type="button" className="link-btn small" onClick={act(() => post('/files/empty-trash'), 'Trash emptied')}>Empty trash</button></>}</td></tr>
            <tr><th>Total</th><td><strong>{formatBytes(total)}</strong>{s.mine?.quota ? ` of ${formatBytes(s.mine.quota)} (your limit)` : ''}</td></tr>
            <tr><th>Your company</th><td>{formatBytes(s.company.used)}{s.company.quota ? ` of ${formatBytes(s.company.quota)}` : ''}</td></tr>
          </tbody>
        </table>
        {s.mine?.quota && <div className="bar" aria-label="Your storage used"><div style={{ width: `${Math.min(100, (s.mine.used / s.mine.quota) * 100)}%` }} /></div>}
        {s.company.quota && <div className="bar" aria-label="Company storage used"><div style={{ width: `${Math.min(100, (s.company.used / s.company.quota) * 100)}%` }} /></div>}
        <strong>Largest items</strong>
        {!s.largest.length ? <p className="muted">Nothing stored yet.</p> : (
          <ul className="storage-list" aria-label="Largest items">
            {s.largest.map((f) => (
              <li key={f.id}>
                <button type="button" className="link-btn grow ellipsis" title="Show it in Drive" onClick={() => { onClose(); navigate(f.trashed ? '/drive/trash' : f.parent_id ? `/drive/folder/${f.parent_id}` : '/drive'); }}>{f.name}</button>
                <span className="muted small">{formatBytes(f.size)}{f.versions_size > 0 && ` + ${formatBytes(f.versions_size)} in ${f.versions} older version${f.versions === 1 ? '' : 's'}`}{f.trashed && ' · in trash'}</span>
                {f.versions_size > 0 && <button type="button" className="btn small" onClick={act(() => del(`/files/${f.id}/versions`), (r) => `Freed ${formatBytes(r.freed)}`)}>Delete older versions</button>}
                {!f.trashed && <button type="button" className="icon-btn" aria-label={`Move ${f.name} to trash`} onClick={act(() => patch(`/files/${f.id}`, { trashed: true }), 'Moved to trash')}><Icon name="trash" size={16} /></button>}
              </li>
            ))}
          </ul>
        )}
        <Duplicates onChanged={() => { load(); onChanged(); }} onShow={(f) => { onClose(); navigate(f.folder ? `/drive/folder/${f.folder.id}` : '/drive'); }} />
        <p className="muted small" style={{ margin: 0 }}>Older versions are kept so you can go back; deleting them can't be undone. Trash is emptied for good after your company's set time.</p>
      </div>
    </Modal>
  );
}

/** Files with exactly the same content as another of yours: keep the newest, trash the rest. */
function Duplicates({ onChanged, onShow }) {
  const toast = useToast();
  const [d, setD] = useState(null); // null: not looked yet; 'busy'
  const look = () => { setD('busy'); get('/files/duplicates').then(setD).catch((e) => { toast(e.message, 'error'); setD(null); }); };
  const trash = async (files) => {
    try { for (const f of files) await patch(`/files/${f.id}`, { trashed: true }); toast(`Moved ${files.length} to trash`); onChanged(); look(); } catch (e) { toast(e.message, 'error'); }
  };
  if (!d) return <div><button type="button" className="btn small" onClick={look}>Find duplicate files</button></div>;
  if (d === 'busy') return <p className="muted small">Looking for files with the same content…</p>;
  return (
    <section className="stack-tight" aria-label="Duplicate files">
      <strong>Duplicate files {d.groups.length > 0 && <span className="muted small">· {formatBytes(d.wasted)} in extra copies</span>}</strong>
      {!d.groups.length ? <p className="muted small" style={{ margin: 0 }}>No duplicates: every file has different content.</p> : (
        <ul className="storage-list dup-list">
          {d.groups.map((g) => (
            <li key={g.files[0].id} className="dup-group">
              <div className="row"><span className="grow small"><strong>{g.files.length} copies</strong> of {formatBytes(g.size)}</span>
                <button type="button" className="btn small" onClick={() => trash(g.files.slice(1))}>Keep the newest, trash {g.files.length - 1}</button></div>
              <ul className="dup-files">
                {g.files.map((f, i) => (
                  <li key={f.id} className="row">
                    <button type="button" className="link-btn grow ellipsis" title="Show it in Drive" onClick={() => onShow(f)}>{f.name}</button>
                    <span className="muted small">{f.folder ? f.folder.name : 'My Drive'} · {formatDate(f.updated_at)}{i === 0 ? ' · newest' : ''}</span>
                    <button type="button" className="icon-btn" aria-label={`Move ${f.name} to trash`} onClick={() => trash([f])}><Icon name="trash" size={16} /></button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {d.incomplete && <p className="muted small" style={{ margin: 0 }}>There's a lot to compare: look again to check the rest.</p>}
    </section>
  );
}

/** Make a colleague the owner; you keep edit access. */
function TransferDialog({ file, onClose, onDone }) {
  const toast = useToast();
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { get('/users/directory').then((l) => setPeople(l.filter((p) => p.id !== user.id))).catch(() => setPeople([])); }, [user.id]);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await post(`/files/${file.id}/transfer`, { user_id: to });
      toast(`${people.find((p) => p.id === to)?.name} now owns “${file.name}”${r.items > 1 ? ` (${r.items} items)` : ''}. You can still edit it.`);
      onClose(); onDone();
    } catch (err) { setError(err.message); }
  };
  return (
    <Modal title="Transfer ownership" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>The new owner decides who has “{file.name}”{file.kind === 'folder' ? ' and everything in it you own' : ''}, and it counts as theirs. You keep edit access.</p>
        <label className="field"><span>New owner</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} required>
            <option value="">Choose a colleague…</option>
            {(people || []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.username})</option>)}
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to}>Transfer</button></div>
      </form>
    </Modal>
  );
}

/** One line of a file's activity, e.g. "Kim Park renamed it from Plan to Plan 2027". */
function activityText(a) {
  const who = a.user_name || (a.action === 'request' ? a.details?.from || 'Someone' : 'Someone');
  const d = a.details || {};
  switch (a.action) {
    case 'create': return `${who} created it`;
    case 'upload': return `${who} uploaded it`;
    case 'request': return `${who} sent it through a file request`;
    case 'copy': return `${who} made it as a copy of ${d.from}`;
    case 'edit': return `${who} edited it`;
    case 'rename': return `${who} renamed it from ${d.from} to ${d.to}`;
    case 'move': return d.to ? `${who} moved it to ${d.to}` : `${who} moved it to My Drive`;
    case 'trash': return `${who} moved it to the trash`;
    case 'restore': return `${who} restored it from the trash`;
    case 'transfer': return `${who} made ${d.to} the owner`;
    case 'version': return `${who} brought back ${d.label ? `the version “${d.label}”` : `the version from ${new Date(d.saved_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}`;
    case 'share': return [d.added?.length && `${who} shared it with ${d.added.join(', ')}`, d.removed?.length && `${d.added?.length ? 'and' : who} stopped sharing it with ${d.removed.join(', ')}`].filter(Boolean).join(' ') || `${who} changed who has it`;
    case 'lock': return `${who} locked it`;
    case 'unlock': return `${who} unlocked it`;
    case 'approval': return d.asked ? `${who} asked ${d.asked.join(', ')} to approve it` : `${who} ${d.decision === 'approved' ? 'approved' : 'rejected'} it${d.comment ? `: “${d.comment}”` : ''}`;
    default: return `${who}: ${a.action}`;
  }
}

/** "1,240 words · 6 min read" for a document in Details. */
function DocLength({ fileId }) {
  const [c, setC] = useState(null);
  useEffect(() => { get(`/files/${fileId}/length`).then(setC).catch(() => setC(false)); }, [fileId]);
  if (c === null) return '…';
  if (!c) return '—';
  return `${c.words.toLocaleString('en-GB')} ${c.words === 1 ? 'word' : 'words'}${c.minutes ? ` · ${c.minutes} min read` : ''}`;
}

/** What happened to a file, newest first (a few, then all). */
function Activity({ fileId }) {
  const [list, setList] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => { get(`/files/${fileId}/activity`).then(setList).catch(() => setList([])); }, [fileId]);
  if (!list?.length) return null;
  const shown = all ? list : list.slice(0, 5);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted small">Activity</span>
      <ul className="file-activity" aria-label="Activity">
        {shown.map((a, i) => (
          <li key={i}><span>{activityText(a)}</span> <span className="muted small" title={new Date(a.at).toLocaleString()}>{new Date(a.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></li>
        ))}
      </ul>
      {list.length > 5 && <button type="button" className="link-btn small" style={{ alignSelf: 'start' }} onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${list.length}`}</button>}
    </div>
  );
}

function VersionsDialog({ file, onClose, onChanged }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [current, setCurrent] = useState(file);
  const [confirm, setConfirm] = useState(null);
  const canEdit = file.role === 'owner' || file.role === 'editor';
  const load = useCallback(() => {
    get(`/files/${file.id}/versions`).then(setList).catch((e) => toast(e.message, 'error'));
    get(`/files/${file.id}`).then(setCurrent).catch(() => {});
  }, [file.id, toast]);
  useEffect(load, [load]);
  const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function restore(v) {
    try { await post(`/files/${file.id}/versions/${v.id}/restore`); toast(`Restored the version from ${when(v.saved_at)}`); load(); onChanged?.(); }
    catch (e) { toast(e.message, 'error'); }
    setConfirm(null);
  }
  async function remove(v) {
    try { await del(`/files/${file.id}/versions/${v.id}`); toast('Version deleted'); load(); onChanged?.(); }
    catch (e) { toast(e.message, 'error'); }
    setConfirm(null);
  }

  if (confirm) {
    const v = confirm.version;
    return confirm.kind === 'restore'
      ? <ConfirmModal title="Restore this version?" danger={false} confirm="Restore" onClose={() => setConfirm(null)} onConfirm={() => restore(v)}
          message={`${file.name} goes back to how it was on ${when(v.saved_at)}. What's there now is kept in the history, so you can switch back.`} />
      : <ConfirmModal title="Delete this version?" confirm="Delete" onClose={() => setConfirm(null)} onConfirm={() => remove(v)}
          message={`The version from ${when(v.saved_at)} is deleted for good${v.size ? `, freeing ${formatBytes(v.size)}` : ''}.`} />;
  }
  const binary = file.kind === 'file';
  return (
    <Modal title={`Version history: ${file.name}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <p className="muted small">{binary ? 'Each time someone uploads a new version, the previous one is kept here.'
        : 'A version is kept from each editing session (when someone else starts editing, or after a 10-minute pause).'} The most recent 50 are kept (named versions, from the editor's Version history, are kept for good), and they count towards your company's storage.</p>
      <ul className="version-list" aria-label="Versions">
        <li className="current">
          <div className="grow"><strong>Current version</strong><span className="muted small">{when(current.updated_at)}{current.updated_by_name ? ` · ${current.updated_by_name}` : ''}{binary ? ` · ${formatBytes(current.size)}` : ''}</span></div>
        </li>
        {list === null && <li className="muted">Loading…</li>}
        {list?.length === 0 && <li className="muted small">No earlier versions yet.</li>}
        {list?.map((v) => (
          <li key={v.id}>
            <div className="grow"><strong>{v.label ? `${v.label} · ` : ''}{when(v.saved_at)}</strong>
              <span className="muted small">{v.saved_by_name || 'Someone'}{binary ? ` · ${formatBytes(v.size)}` : ''}{v.name !== current.name ? ` · named “${v.name}”` : ''}</span></div>
            {binary && <a className="icon-btn" href={`/api/files/${file.id}/versions/${v.id}/raw?download`} aria-label={`Download the version from ${when(v.saved_at)}`} title="Download"><Icon name="download" size={18} /></a>}
            {canEdit && <button type="button" className="btn small" onClick={() => setConfirm({ kind: 'restore', version: v })} aria-label={`Restore the version from ${when(v.saved_at)}`}>Restore</button>}
            {file.role === 'owner' && <button type="button" className="icon-btn" onClick={() => setConfirm({ kind: 'delete', version: v })} aria-label={`Delete the version from ${when(v.saved_at)}`} title="Delete"><Icon name="trash" size={18} /></button>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Where a search matched inside a file: the server marks the matching words with \u0001 … \u0002. */
function MatchText({ text }) {
  const parts = String(text).split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span className="match small muted">
      {parts.map((p, i) => (p.startsWith('\u0001') ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}

/** Rename several at once: find and replace in the names, text before and after, with a preview of every new name. */
function RenameMany({ files, onClose, onDone }) {
  const toast = useToast();
  const [r, setR] = useState({ find: '', replace: '', match_case: false, prefix: '', suffix: '', base: '', number: false, start: 1 });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const ids = files.map((f) => f.id);
  const any = r.find || r.prefix || r.suffix || r.base.trim() || r.number;
  useEffect(() => {
    if (!any) { setPreview(null); return undefined; }
    let live = true;
    const t = setTimeout(() => post('/files/rename-many', { ids, ...r, preview: true }).then((x) => { if (live) setPreview(x); }).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [r]); // eslint-disable-line react-hooks/exhaustive-deps
  const changing = (preview || []).filter((x) => x.to && !x.same);
  const go = async () => {
    setBusy(true);
    try { const out = await post('/files/rename-many', { ids, ...r }); onDone(out.filter((x) => x.to && !x.same)); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  const set = (k) => (e) => setR({ ...r, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal wide title={`Rename ${files.length} items`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !changing.length} onClick={go}>{changing.length ? `Rename ${changing.length}` : 'Rename'}</button></>}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field grow"><span>Find</span><input value={r.find} onChange={set('find')} autoFocus /></label>
          <label className="field grow"><span>Replace with</span><input value={r.replace} onChange={set('replace')} disabled={!r.find} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={r.match_case} onChange={set('match_case')} disabled={!r.find} /> Match case</label>
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field grow"><span>Add before</span><input value={r.prefix} onChange={set('prefix')} placeholder="2026 " /></label>
          <label className="field grow"><span>Add after</span><input value={r.suffix} onChange={set('suffix')} placeholder=" (final)" /></label>
        </div>
        <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
          <label className="field grow"><span>New name for all (optional)</span><input value={r.base} onChange={set('base')} placeholder="Holiday" /></label>
          <label className="check"><input type="checkbox" checked={r.number} onChange={set('number')} /> Number them</label>
          {r.number && <label className="field" style={{ width: 110, flex: 'none' }}><span>Start at</span><input type="number" min="0" value={r.start} onChange={(e) => setR({ ...r, start: Number(e.target.value) || 0 })} /></label>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Text added after, and numbers, go before a file's extension (report.pdf → report (final).pdf). Numbers follow the names' order (img2 before img10), with the same number of digits. A name that's taken in the same folder gets a number.</p>
        <table className="files rename-preview" aria-label="New names">
          <thead><tr><th>Now</th><th>Becomes</th></tr></thead>
          <tbody>
            {(preview || files.map((f) => ({ id: f.id, from: f.name, to: f.name, same: true }))).map((x) => (
              <tr key={x.id}><td className="ellipsis">{x.from ?? files.find((f) => f.id === x.id)?.name}</td>
                <td className={x.error ? 'error small' : x.same ? 'muted' : ''}>{x.error || (x.same ? 'unchanged' : x.to)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
