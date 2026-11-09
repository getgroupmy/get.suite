// Files shared to Workspace from another app (the phone's Share menu): which folder to save them
// in, then they're uploaded like any file. Links and text shared without a file are offered as a
// small text file. Nothing is saved until you say so; Cancel forgets them.
import { useEffect, useState } from 'react';
import { get, formatBytes } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import Icon, { fileIcon } from '../../components/Icon.jsx';
import { clearShared } from '../../shareinbox.js';

async function upload(file, parent) {
  const q = new URLSearchParams({ name: file.name });
  if (parent) q.set('parent', parent);
  const res = await fetch(`/api/files/upload?${q}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: file });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Couldn’t save ${file.name}`);
  return res.json();
}

export default function SharedInDialog({ shared, onClose, onSaved }) {
  const toast = useToast();
  const [folders, setFolders] = useState([]);
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(null); // "Saving 1 of 3"
  // Shared without a file (a link, some text): kept as a little text file.
  const files = shared.files?.length ? shared.files
    : (shared.url || shared.text) ? [new File([[shared.title, shared.text, shared.url].filter(Boolean).join('\n') + '\n'], `${(shared.title || 'Shared link').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Shared'}.txt`, { type: 'text/plain' })] : [];
  useEffect(() => {
    Promise.all([get('/files').catch(() => []), get('/files?view=drives').catch(() => [])])
      .then(([mine, drives]) => setFolders([...mine.filter((f) => f.kind === 'folder' && !f.shortcut_id).map((f) => ({ id: f.id, name: f.name })),
        ...drives.filter((d) => ['owner', 'editor'].includes(d.role)).map((d) => ({ id: d.id, name: `${d.name} (shared drive)` }))]));
  }, []);
  const save = async () => {
    try {
      for (let i = 0; i < files.length; i++) { setBusy(`Saving ${i + 1} of ${files.length}…`); await upload(files[i], parent || null); }
      await clearShared();
      toast(`Saved ${files.length} file${files.length === 1 ? '' : 's'} to Drive`);
      onSaved(parent || null);
    } catch (e) { toast(e.message, 'error'); setBusy(null); }
  };
  const cancel = async () => { await clearShared(); onClose(); };
  return (
    <Modal title="Save to Drive" onClose={cancel}>
      <div className="stack">
        {!files.length ? <p>Nothing that can be saved came with it.</p> : (
          <ul className="share-list" aria-label="Shared files">
            {files.map((f, i) => <li key={i}><Icon name={fileIcon({ kind: 'file', name: f.name, mime: f.type })} /><span className="grow ellipsis">{f.name}</span><span className="muted small">{formatBytes(f.size)}</span></li>)}
          </ul>
        )}
        <label className="field"><span>Save in</span>
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">My Drive</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={cancel} disabled={!!busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={save} disabled={!files.length || !!busy}>{busy || 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
