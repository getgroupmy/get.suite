import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { get, post, patch, del, put, uploadFile, uploadVersion, onLive, formatBytes, formatDate } from '../../api.js';
import Icon, { fileIcon } from '../../components/Icon.jsx';
import { Menu, Modal, PromptModal, ConfirmModal, Empty, useToast, Avatar } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

function useDriveRoute() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const parts = pathname.replace(/^\/drive\/?/, '').split('/');
  if (parts[0] === 'folder' && parts[1]) return { view: 'mine', folderId: parts[1] };
  if (['shared', 'recent', 'trash'].includes(parts[0])) return { view: parts[0] };
  if (parts[0] === 'search') return { view: 'search', q: params.get('q') || '' };
  return { view: 'mine', folderId: null };
}

export function openPath(f) {
  if (f.kind === 'folder') return `/drive/folder/${f.id}`;
  if (f.kind === 'doc') return `/docs/${f.id}`;
  if (f.kind === 'sheet') return `/sheets/${f.id}`;
  if (f.kind === 'slides') return `/slides/${f.id}`;
  return null;
}

const TITLES = { shared: 'Shared with me', recent: 'Recent', trash: 'Trash' };

export default function Drive() {
  const route = useDriveRoute();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [files, setFiles] = useState(null);
  const [crumbs, setCrumbs] = useState([]);
  const [folder, setFolder] = useState(null);
  const [usage, setUsage] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState(null);
  const fileInput = useRef();

  const key = `${route.view}:${route.folderId || ''}:${route.q || ''}`;

  const load = useCallback(async () => {
    try {
      let url = `/files?view=${route.view}`;
      if (route.folderId) url += `&parent=${route.folderId}`;
      if (route.view === 'search') url += `&q=${encodeURIComponent(route.q)}`;
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

  useEffect(() => { setFiles(null); setSelected(null); load(); }, [load]);
  useEffect(() => onLive((m) => {
    if (m.type === 'files-changed' || m.type === 'content-changed' || m.type === 'live-connected') load();
  }), [load]);

  const parentId = route.view === 'mine' ? route.folderId : null;
  const canCreate = route.view === 'mine' && (!folder || folder.role !== 'viewer');

  async function startUploads(list) {
    if (!canCreate) return toast('Open a folder you can edit to upload files', 'error');
    const items = [...list].map((file) => ({ id: Math.random(), name: file.name, progress: 0, file }));
    setUploads((u) => [...u, ...items]);
    for (const it of items) {
      try {
        await uploadFile(it.file, parentId, (p) => setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, progress: p } : x))));
        setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, progress: 1, done: true } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === it.id ? { ...x, error: e.message } : x)));
      }
    }
    load();
  }

  // Upload new version: pick a file, it replaces the contents (the old ones stay in the history).
  const versionInput = useRef();
  const versionFor = useRef(null);
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
    const canEdit = f.role === 'owner' || f.role === 'editor';
    if (route.view === 'trash') return [
      { label: 'Restore', icon: 'restore', onClick: act(() => patch(`/files/${f.id}`, { trashed: false }), 'Restored') },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', file: f }) },
    ];
    return [
      { label: 'Open', icon: fileIcon(f), onClick: () => open(f) },
      officeAs(f) && { label: `Open as ${officeAs(f).what}`, icon: officeAs(f).icon, onClick: () => openAs(f) },
      f.kind === 'file' && { label: 'Download', icon: 'download', onClick: () => { location.href = `/api/files/${f.id}/raw?download`; } },
      '-',
      f.role === 'owner' && { label: 'Share', icon: 'share', onClick: () => setDialog({ type: 'share', file: f }) },
      canEdit && { label: 'Rename', icon: 'edit', onClick: () => setDialog({ type: 'rename', file: f }) },
      canEdit && { label: 'Move to…', icon: 'move', onClick: () => setDialog({ type: 'move', file: f }) },
      f.kind !== 'folder' && '-',
      f.kind === 'file' && canEdit && { label: 'Upload new version', icon: 'upload', onClick: () => { versionFor.current = f; versionInput.current.click(); } },
      f.kind !== 'folder' && { label: 'Version history', icon: 'clock', onClick: () => setDialog({ type: 'versions', file: f }) },
      canEdit && '-',
      canEdit && { label: 'Move to trash', icon: 'trash', danger: true, onClick: act(() => patch(`/files/${f.id}`, { trashed: true }), 'Moved to trash') },
    ];
  }

  const title = route.view === 'search' ? `Search results for “${route.q}”` : TITLES[route.view];

  return (
    <div className="drive">
      <aside className="subnav">
        <Menu align="left" trigger={(p) => <button className="btn new-btn" {...p} disabled={!canCreate}><Icon name="plus" /> New</button>} items={[
          { label: 'New folder', icon: 'folder', onClick: () => setDialog({ type: 'folder' }) },
          '-',
          { label: 'Upload files', icon: 'upload', onClick: () => fileInput.current.click() },
          '-',
          { label: 'Document', icon: 'doc', onClick: () => create('doc') },
          { label: 'Spreadsheet', icon: 'sheet', onClick: () => create('sheet') },
          { label: 'Presentation', icon: 'slides', onClick: () => create('slides') },
        ]} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { startUploads(e.target.files); e.target.value = ''; }} />
        <NavLink end to="/drive" className={() => `subnav-item ${route.view === 'mine' ? 'active' : ''}`}><Icon name="folder" />My Drive</NavLink>
        <NavLink to="/drive/shared" className="subnav-item"><Icon name="people" />Shared with me</NavLink>
        <NavLink to="/drive/recent" className="subnav-item"><Icon name="clock" />Recent</NavLink>
        <NavLink to="/drive/trash" className="subnav-item"><Icon name="trash" />Trash</NavLink>
        {usage && (
          <div className="usage">
            <div className="muted small">{formatBytes(usage.used)} used{usage.disk && ` · ${formatBytes(usage.disk.free)} free on NAS`}</div>
            {usage.disk && <div className="bar"><div style={{ width: `${Math.min(100, (1 - usage.disk.free / usage.disk.total) * 100)}%` }} /></div>}
          </div>
        )}
      </aside>

      <section
        className={`drive-main ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { if (canCreate && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files); }}
      >
        <div className="drive-head">
          {title ? <h1>{title}</h1> : (
            <nav className="crumbs" aria-label="Folder path">
              <button className="crumb" onClick={() => navigate('/drive')}>My Drive</button>
              {crumbs.map((c) => (
                <span key={c.id} className="crumb-wrap"><Icon name="right" size={18} />
                  <button className="crumb" onClick={() => navigate(`/drive/folder/${c.id}`)}>{c.name}</button></span>
              ))}
            </nav>
          )}
          {route.view === 'trash' && files?.length > 0 && (
            <button className="btn" onClick={() => setDialog({ type: 'empty-trash' })}>Empty trash</button>
          )}
        </div>
        {folder && folder.owner_id !== user.id && <p className="muted small">Owned by {folder.owner_name} · you can {folder.role === 'viewer' ? 'view' : 'edit'}</p>}

        {files === null ? <p className="muted">Loading…</p> : files.length === 0 ? (
          route.view === 'trash' ? <Empty icon="trash" title="Trash is empty" />
            : route.view === 'search' ? <Empty icon="search" title="No matching files" />
              : route.view === 'shared' ? <Empty icon="people" title="Nothing shared with you yet" />
                : <Empty icon="upload" title="Drop files here">or use the New button to create a folder, document or spreadsheet</Empty>
        ) : (
          <table className="files">
            <thead><tr><th>Name</th><th className="hide-sm">Owner</th><th className="hide-sm">Modified</th><th className="hide-sm">Size</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id} className={selected === f.id ? 'selected' : ''} tabIndex={0}
                  onClick={() => setSelected(f.id)} onDoubleClick={() => route.view !== 'trash' && open(f)}
                  onKeyDown={(e) => e.key === 'Enter' && route.view !== 'trash' && open(f)}>
                  <td className="name"><Icon name={fileIcon(f)} className={`ft ft-${fileIcon(f)}`} /><span className="name-text">{f.name}{f.match && <MatchText text={f.match} />}</span></td>
                  <td className="hide-sm muted">{f.owner_id === user.id ? 'me' : f.owner_name}</td>
                  <td className="hide-sm muted">{formatDate(f.updated_at)}</td>
                  <td className="hide-sm muted">{f.kind === 'folder' ? '—' : formatBytes(f.size)}</td>
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
      {dialog?.type === 'move' && <MoveDialog file={dialog.file} onClose={() => setDialog(null)} onMoved={load} />}
      {dialog?.type === 'preview' && <Preview file={dialog.file} onClose={() => setDialog(null)} onOpenAs={() => { setDialog(null); openAs(dialog.file); }} />}
      {dialog?.type === 'versions' && <VersionsDialog file={dialog.file} onClose={() => setDialog(null)} onChanged={load} />}
      <input ref={versionInput} type="file" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { uploadNewVersion(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

export function ShareDialog({ file, onClose }) {
  const toast = useToast();
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [shares, setShares] = useState(null);
  const [address, setAddress] = useState('');
  const [role, setRole] = useState('viewer');
  const [error, setError] = useState('');

  useEffect(() => {
    get('/users/directory').then(setPeople);
    get(`/files/${file.id}/shares`).then(setShares);
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
      await put(`/files/${file.id}/shares`, { shares: shares.map(({ user_id, role }) => ({ user_id, role })) });
      toast('Sharing updated');
      onClose();
    } catch (e) { toast(e.message, 'error'); }
  }

  const external = shares?.filter((s) => s.external).length || 0;

  return (
    <Modal title={`Share “${file.name}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!shares}>Save</button></>}>
      <form className="row" onSubmit={add}>
        <input className="grow" list="share-people" type="email" value={address} placeholder="Add people by email address"
          aria-label="Email address" autoFocus onChange={(e) => { setAddress(e.target.value); setError(''); }} />
        <datalist id="share-people">
          {suggestions.map((p) => <option key={p.id} value={p.username}>{p.name}</option>)}
        </datalist>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Access">
          <option value="viewer">Viewer</option><option value="editor">Editor</option>
        </select>
        <button className="btn" disabled={!address.trim()}>Add</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
      {!user.allow_external && <p className="muted small">Your company only allows sharing with colleagues.</p>}
      <ul className="share-list">
        <li><Avatar name={file.owner_name} size={28} /><span className="grow">{file.owner_name}</span><span className="muted">Owner</span></li>
        {shares?.map((s) => (
          <li key={s.user_id}>
            <Avatar name={s.name} size={28} />
            <span className="grow ellipsis">{s.name} <span className="muted small">{s.username}</span>
              {s.external && <span className="pill ext">External · {s.org_name}</span>}</span>
            <select value={s.role} aria-label={`Access for ${s.name}`} onChange={(e) => setShares(shares.map((x) => (x.user_id === s.user_id ? { ...x, role: e.target.value } : x)))}>
              <option value="viewer">Viewer</option><option value="editor">Editor</option>
            </select>
            <button className="icon-btn" aria-label={`Remove ${s.name}`} onClick={() => setShares(shares.filter((x) => x.user_id !== s.user_id))}><Icon name="close" size={18} /></button>
          </li>
        ))}
      </ul>
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
  const { user } = useAuth();
  const [links, setLinks] = useState(null);
  const [days, setDays] = useState('7');
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user.allow_links) get(`/links?file=${file.id}`).then(setLinks).catch(() => setLinks([])); }, [file.id, user.allow_links]);

  if (!user.allow_links) return <section className="link-share"><h3>Link sharing</h3><p className="muted small">Your company has turned off links for people without an account.</p></section>;

  async function create() {
    setBusy(true);
    try {
      const l = await post('/links', { file_id: file.id, expires_at: days ? Date.now() + Number(days) * 864e5 : null, ...(usePassword && { password }) });
      setLinks([...links, l]);
      setPassword(''); setUsePassword(false);
      await copy(l, 'Link created and copied');
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
      <h3>Link sharing</h3>
      <p className="muted small">Anyone with a link can view and download {what}, without an account.</p>
      <ul className="share-list">
        {links?.map((l) => (
          <li key={l.id} className={l.expired ? 'expired' : ''}>
            <Icon name="link" size={20} />
            <div className="grow" style={{ minWidth: 0 }}>
              <input className="link-url" readOnly value={linkUrl(l.token)} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <span className="muted small">
                {[l.expired ? 'Expired' : l.expires_at ? `Until ${formatDate(l.expires_at)}` : 'No expiry',
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
        {usePassword && <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" aria-label="Link password" autoComplete="off" />}
        <button type="button" className="btn" onClick={create} disabled={!links || busy || (usePassword && password.length < 6)}><Icon name="link" size={18} /> Create link</button>
      </div>
      {usePassword && <p className="muted small">Send the password separately from the link, for example by phone.</p>}
    </section>
  );
}

function MoveDialog({ file, onClose, onMoved }) {
  const toast = useToast();
  const [cur, setCur] = useState(null); // null = My Drive root
  const [path, setPath] = useState([]);
  const [folders, setFolders] = useState([]);

  useEffect(() => {
    get(`/files?view=mine${cur ? `&parent=${cur}` : ''}`).then((l) => setFolders(l.filter((f) => f.kind === 'folder' && f.id !== file.id)));
    if (cur) get(`/files/${cur}/path`).then(setPath); else setPath([]);
  }, [cur, file.id]);

  async function move() {
    try { await patch(`/files/${file.id}`, { parent_id: cur }); toast('Moved'); onMoved(); onClose(); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <Modal title={`Move “${file.name}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={move}>Move here</button></>}>
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

/** Office files that can open as Docs, Sheets or Slides. */
export function officeAs(f) {
  if (f.kind !== 'file') return null;
  const ext = (/\.([a-z]+)$/i.exec(f.name) || [])[1]?.toLowerCase();
  return { docx: { what: 'document', icon: 'doc' }, xlsx: { what: 'spreadsheet', icon: 'sheet' }, pptx: { what: 'presentation', icon: 'slides' } }[ext] || null;
}

function Preview({ file, onClose, onOpenAs }) {
  const src = `/api/files/${file.id}/raw`;
  const m = file.mime || '';
  let body;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m)) body = <img src={src} alt={file.name} className="preview-media" />;
  else if (/^video\/(mp4|webm)$/.test(m)) body = <video src={src} controls className="preview-media" />;
  else if (m.startsWith('audio/')) body = <audio src={src} controls />;
  else if (m === 'application/pdf' || m.startsWith('text/')) body = <iframe src={src} title={file.name} className="preview-frame" />;
  else if (officeAs(file)) body = <Empty icon={officeAs(file).icon} title={`Open it as a ${officeAs(file).what}`}>Workspace makes an editable copy next to it; the original stays as it is.</Empty>;
  else body = <Empty icon="file" title="No preview available">Download the file to open it on your device.</Empty>;
  return (
    <Modal wide title={file.name} onClose={onClose} footer={<>
      {officeAs(file) && <button type="button" className="btn primary" onClick={onOpenAs}><Icon name={officeAs(file).icon} size={18} /> Open as {officeAs(file).what}</button>}
      <a className={`btn ${officeAs(file) ? '' : 'primary'}`} href={`${src}?download`}><Icon name="download" size={18} /> Download</a>
    </>}>
      <div className="preview">{body}</div>
      <p className="muted small">{formatBytes(file.size)} · modified {formatDate(file.updated_at)}</p>
    </Modal>
  );
}

/** Earlier versions of a file: download or look at them, bring one back, or delete it. */
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
        : 'A version is kept from each editing session (when someone else starts editing, or after a 10-minute pause).'} The most recent 50 are kept, and they count towards your company's storage.</p>
      <ul className="version-list" aria-label="Versions">
        <li className="current">
          <div className="grow"><strong>Current version</strong><span className="muted small">{when(current.updated_at)}{current.updated_by_name ? ` · ${current.updated_by_name}` : ''}{binary ? ` · ${formatBytes(current.size)}` : ''}</span></div>
        </li>
        {list === null && <li className="muted">Loading…</li>}
        {list?.length === 0 && <li className="muted small">No earlier versions yet.</li>}
        {list?.map((v) => (
          <li key={v.id}>
            <div className="grow"><strong>{when(v.saved_at)}</strong>
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
