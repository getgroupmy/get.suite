// "Make a copy…" in a document's, spreadsheet's or presentation's ⋮ menu: a name for the copy and, if wanted,
// shared with the same people (and groups) as this one, and its open comments too. The copy then opens.
import { useState } from 'react';
import { Modal, useToast } from './ui.jsx';
import { post } from '../api.js';

const PATH = { doc: 'docs', sheet: 'sheets', slides: 'slides' };

export default function MakeCopy({ file, onClose }) {
  const toast = useToast();
  const [name, setName] = useState(`Copy of ${file.name}`);
  const [share, setShare] = useState(false);
  const [comments, setComments] = useState(false);
  const [busy, setBusy] = useState(false);
  const make = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const c = await post(`/files/${file.id}/copy`, { name: name.trim() || `Copy of ${file.name}`, share_same: share, comments });
      window.location.href = `/${PATH[c.kind] || 'drive'}/${c.id}`;
    } catch (err) { toast(err.message || 'Couldn’t make a copy', 'error'); setBusy(false); }
  };
  return (
    <Modal title="Make a copy" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy} onClick={make}>Make a copy</button>
    </>}>
      <form className="stack" onSubmit={make}>
        <label className="field"><span>Name</span>
          <input autoFocus maxLength={255} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share it with the same people</label>
        <label className="check"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} /> Copy comments (the open ones, with their replies)</label>
        <p className="muted small" style={{ margin: 0 }}>It goes next to this one (or in your Drive). Version history stays with this one.</p>
      </form>
    </Modal>
  );
}
