// Save to a folder…: pick one of your folders in My Drive, or a shared drive you can edit, for a chat attachment.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { saveToDrive } from './savefile.js';

export default function SaveToFolder({ messageId, file, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [folders, setFolders] = useState(null);
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([get('/files').catch(() => []), get('/files?view=drives').catch(() => [])])
      .then(([mine, drives]) => setFolders([...mine.filter((f) => f.kind === 'folder' && !f.shortcut_id).map((f) => ({ id: f.id, name: f.name })),
        ...drives.filter((d) => ['owner', 'editor'].includes(d.role)).map((d) => ({ id: d.id, name: `${d.name} (shared drive)` }))]));
  }, []);
  const save = async () => {
    setBusy(true);
    if (await saveToDrive(toast, navigate, messageId, file, parent || null)) onClose();
    else setBusy(false);
  };
  return (
    <Modal title={`Save “${file.name}” to Drive`} onClose={onClose}>
      <div className="stack">
        <label className="field"><span>Save in</span>
          <select value={parent} onChange={(e) => setParent(e.target.value)} disabled={folders === null}>
            <option value="">My Drive</option>
            {(folders || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || folders === null}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
