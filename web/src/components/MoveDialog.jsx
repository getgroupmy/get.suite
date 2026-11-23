// Move (or copy, or add a shortcut to) files into a folder: walk down from My Drive, find a folder by name,
// or pick one you moved things to lately. Used by Drive, and by Mail after saving attachments.
import { useEffect, useState } from 'react';
import { get, post, patch } from '../api.js';
import { Modal, useToast } from './ui.jsx';
import Icon from './Icon.jsx';

// pick: { title, action, onPick(folderId or null) } chooses a folder without moving anything (Chat's "Save to a folder…").
export default function MoveDialog({ files, onClose, onMoved, onCopy, shortcut = false, copy = false, pick = null }) {
  const toast = useToast();
  const [cur, setCur] = useState(null); // null = My Drive root
  const [path, setPath] = useState([]);
  const [folders, setFolders] = useState([]);
  // Where you last moved things to: one click away (not where these already are).
  const [recent, setRecent] = useState([]);
  useEffect(() => { get('/files/recent-destinations').then((l) => setRecent(l.filter((f) => !files.some((x) => x.id === f.id || x.parent_id === f.id)))).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Find a folder by name (deep in My Drive, or in a shared drive or folder you can add to) instead of walking to it.
  const [find, setFind] = useState('');
  const [hits, setHits] = useState(null);
  useEffect(() => {
    const t = find.trim();
    if (t.length < 2) { setHits(null); return undefined; }
    let live = true;
    const h = setTimeout(() => get(`/files?view=search&type=folder&q=${encodeURIComponent(t)}`)
      .then((l) => { if (live) setHits(l.filter((f) => f.kind === 'folder' && (f.role === 'owner' || f.role === 'editor') && !files.some((x) => x.id === f.id))); })
      .catch(() => { if (live) setHits([]); }), 200);
    return () => { live = false; clearTimeout(h); };
  }, [find]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    get(`/files?view=mine&noshortcuts=1${cur ? `&parent=${cur}` : ''}`).then((l) => setFolders(l.filter((f) => f.kind === 'folder' && !files.some((x) => x.id === f.id))));
    if (cur) get(`/files/${cur}/path`).then(setPath); else setPath([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  // Choosing where to save: shared drives you can add to are offered beside your own folders.
  const [drives, setDrives] = useState([]);
  useEffect(() => { if (pick) get('/files?view=drives').then((l) => setDrives(l.filter((d) => d.role === 'owner' || d.role === 'editor'))).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function move() {
    if (pick) { onClose(); pick.onPick(cur); return; }
    if (copy) { onClose(); onCopy(cur); return; }
    if (shortcut) {
      try { const r = await post(`/files/${files[0].id}/shortcut`, { parent_id: cur }); toast(r.existing ? 'There’s already a shortcut to it there' : 'Shortcut added'); onMoved(); onClose(); } catch (e) { toast(e.message, 'error'); }
      return;
    }
    const moved = []; // where each was, for Undo
    for (const f of files) { try { await patch(`/files/${f.id}`, { parent_id: cur }); moved.push({ id: f.id, parent_id: f.parent_id ?? null }); } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); } }
    onMoved(moved, cur); onClose(); // (and where to: a folder's id, or null for My Drive)
  }

  return (
    <Modal title={pick ? pick.title : copy ? (files.length === 1 ? `Copy “${files[0].name}” to…` : `Copy ${files.length} items to…`) : shortcut ? `Add a shortcut to “${files[0].name}”` : files.length === 1 ? `Move “${files[0].name}”` : `Move ${files.length} items`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={move}>{pick ? pick.action : copy ? 'Copy here' : shortcut ? 'Add shortcut here' : 'Move here'}</button></>}>
      {copy && <p className="muted small" style={{ marginTop: 0 }}>The original stays where it is. A copy keeps its name, unless it goes in the same folder (then it’s “Copy of …”).</p>}
      {shortcut && <p className="muted small" style={{ marginTop: 0 }}>It stays where it is; the shortcut opens it from this folder too. People still need access to it to open it.</p>}
      <input type="search" className="move-find" aria-label="Find a folder" placeholder="Find a folder" value={find} onChange={(e) => setFind(e.target.value)} />
      {hits && (
        <ul className="pick-list" aria-label="Folders found">
          {hits.length === 0 && <li className="muted">No folder you can add to is called that</li>}
          {hits.slice(0, 20).map((f) => (
            <li key={f.id}><button onClick={() => { setCur(f.id); setFind(''); }}><Icon name="folder" className="ft ft-folder" />
              <span className="grow">{f.name}{(f.parent_name || (!f.parent_id && f.role === 'owner')) && <span className="muted small"> · in {f.parent_name || 'My Drive'}</span>}</span><Icon name="right" size={18} /></button></li>
          ))}
        </ul>
      )}
      {!hits && !cur && recent.length > 0 && (
        <>
          <div className="small muted move-section">Recent</div>
          <ul className="pick-list" aria-label="Recent folders">
            {recent.map((f) => (
              <li key={f.id}><button onClick={() => setCur(f.id)}><Icon name="folder" className="ft ft-folder" />
                <span className="grow">{f.name}{(f.parent_name || f.in_my_drive) && <span className="muted small"> · in {f.parent_name || 'My Drive'}</span>}</span><Icon name="right" size={18} /></button></li>
            ))}
          </ul>
          <div className="small muted move-section">All folders</div>
        </>
      )}
      {!hits && <>
      <nav className="crumbs small">
        <button className="crumb" onClick={() => setCur(null)}>My Drive</button>
        {path.map((c) => <span key={c.id} className="crumb-wrap"><Icon name="right" size={16} /><button className="crumb" onClick={() => setCur(c.id)}>{c.name}</button></span>)}
      </nav>
      <ul className="pick-list">
        {folders.length === 0 && <li className="muted">No folders here</li>}
        {folders.map((f) => <li key={f.id}><button onClick={() => setCur(f.id)}><Icon name="folder" className="ft ft-folder" />{f.name}<Icon name="right" size={18} /></button></li>)}
        {!cur && drives.map((d) => <li key={d.id}><button onClick={() => setCur(d.id)}><Icon name="people" className="ft ft-folder" /><span className="grow">{d.name} <span className="muted small">· shared drive</span></span><Icon name="right" size={18} /></button></li>)}
      </ul>
      </>}
    </Modal>
  );
}
