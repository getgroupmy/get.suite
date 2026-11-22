// Sheets → Add rows to Tasks: the sheet's rows (laid out as Tasks' Import from CSV reads them: Title, Due, Notes…) added to
// the end of a list you pick.
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { Modal } from '../../components/ui.jsx';

export function SheetToTasksDialog({ fileId, sheet, onClose, onDone }) {
  const [lists, setLists] = useState(null);
  const [list, setList] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/tasks/lists').then((r) => { const ls = r.lists || []; setLists(ls); setList(ls[0]?.id || ''); }).catch((e) => setError(e.message)); }, []);
  const add = async () => {
    setBusy(true); setError(null);
    try { onDone(await post(`/tasks/lists/${list}/from-sheet`, { file: fileId, sheet })); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title="Add rows to Tasks" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !list} onClick={add}>Add tasks</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Each row becomes a task. Give the sheet a <strong>Title</strong> column (and <strong>Due</strong>, <strong>Notes</strong>, <strong>Steps</strong>… if you like), as Tasks’ Import from CSV reads them.</p>
      {lists === null && !error ? <p className="muted">Loading…</p> : lists?.length
        ? <label className="field"><span>List</span><select value={list} onChange={(e) => setList(e.target.value)}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        : !error && <p className="muted">You have no task lists yet.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Modal>
  );
}
