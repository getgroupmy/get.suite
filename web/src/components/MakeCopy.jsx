// "Make a copy…" in a document's, spreadsheet's or presentation's ⋮ menu: a name for the copy, where it goes (next
// to this one, or a folder you choose), and, if wanted, shared with the same people (and groups) as this one, and its
// open comments too. The copy then opens.
import { useEffect, useState } from 'react';
import { Modal, useToast } from './ui.jsx';
import Icon from './Icon.jsx';
import { get, post } from '../api.js';

const PATH = { doc: 'docs', sheet: 'sheets', slides: 'slides' };

/** Browsing your folders to pick one: { cur, path, folders, go(id) }. */
function useFolders(active) {
  const [cur, setCur] = useState(null);
  const [path, setPath] = useState([]);
  const [folders, setFolders] = useState(null);
  useEffect(() => {
    if (!active) return;
    setFolders(null);
    get(`/files?view=mine&noshortcuts=1${cur ? `&parent=${cur}` : ''}`).then((l) => setFolders(l.filter((f) => f.kind === 'folder'))).catch(() => setFolders([]));
    if (cur) get(`/files/${cur}/path`).then(setPath).catch(() => setPath([])); else setPath([]);
  }, [cur, active]);
  return { cur, path, folders, go: setCur };
}

export default function MakeCopy({ file, onClose }) {
  const toast = useToast();
  const [name, setName] = useState(`Copy of ${file.name}`);
  const [share, setShare] = useState(false);
  const [comments, setComments] = useState(false);
  const [busy, setBusy] = useState(false);
  // Where: undefined = next to this one; null = My Drive; else { id, name }
  const [where, setWhere] = useState(undefined);
  const [browsing, setBrowsing] = useState(false);
  const b = useFolders(browsing);
  const make = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const c = await post(`/files/${file.id}/copy`, { name: name.trim() || `Copy of ${file.name}`, share_same: share, comments, ...(where !== undefined && { parent_id: where?.id ?? null }) });
      window.location.href = `/${PATH[c.kind] || 'drive'}/${c.id}`;
    } catch (err) { toast(err.message || 'Couldn’t make a copy', 'error'); setBusy(false); }
  };
  const here = b.cur ? b.path[b.path.length - 1]?.name || 'this folder' : 'My Drive';
  return (
    <Modal title="Make a copy" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy || browsing} onClick={make}>Make a copy</button>
    </>}>
      <form className="stack" onSubmit={make}>
        <label className="field"><span>Name</span>
          <input autoFocus maxLength={255} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="row" aria-label="Folder" role="group">
          <span className="grow">Folder: <strong>{where === undefined ? 'Next to this one' : where === null ? 'My Drive' : where.name}</strong></span>
          {!browsing && <button type="button" className="btn small" onClick={() => setBrowsing(true)}>Change…</button>}
        </div>
        {browsing && (
          <div className="stack-tight">
            <nav className="crumbs small">
              <button type="button" className="crumb" onClick={() => b.go(null)}>My Drive</button>
              {b.path.map((c) => <span key={c.id} className="crumb-wrap"><Icon name="right" size={16} /><button type="button" className="crumb" onClick={() => b.go(c.id)}>{c.name}</button></span>)}
            </nav>
            <ul className="pick-list" aria-label="Folders">
              {b.folders === null ? <li className="muted">Loading…</li> : b.folders.length === 0 ? <li className="muted">No folders here</li>
                : b.folders.map((f) => <li key={f.id}><button type="button" onClick={() => b.go(f.id)}><Icon name="folder" className="ft ft-folder" />{f.name}<Icon name="right" size={18} /></button></li>)}
            </ul>
            <div className="row">
              <button type="button" className="btn small primary" onClick={() => { setWhere(b.cur ? { id: b.cur, name: here } : null); setBrowsing(false); }}>Put it in {here}</button>
              <button type="button" className="btn small" onClick={() => setBrowsing(false)}>Back</button>
            </div>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share it with the same people</label>
        <label className="check"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} /> Copy comments (the open ones, with their replies)</label>
        <p className="muted small" style={{ margin: 0 }}>Version history stays with this one.</p>
      </form>
    </Modal>
  );
}
