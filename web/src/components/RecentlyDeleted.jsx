// Recently deleted task lists or forms (yours), each with Restore: they're kept 30 days (server/src/recyclebin.js).
import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { Empty, Modal, useToast } from './ui.jsx';

const when = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });

export default function RecentlyDeleted({ title, list, restore, what, onRestored, onClose }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { get(list).then(setItems).catch((e) => toast(e.message, 'error')); }, [list, toast]);
  const put = async (x) => {
    if (busy) return;
    setBusy(x.id);
    try { const r = await post(restore(x.id)); toast(`“${x.name}” is back`); onRestored(r); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>{what} you delete are kept here for 30 days, then deleted for good. Restoring brings back everything in them, for everyone they were shared with.</p>
      {items === null ? <p className="muted">Loading…</p> : !items.length ? <Empty icon="trash" title="Nothing deleted lately" /> : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={title}>
          {items.map((x) => (
            <li key={x.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{x.name || 'Untitled'}</strong> <span className="muted small">deleted {when(x.deleted_at)} · kept until {when(x.until)}</span></span>
              <button type="button" className="btn small" disabled={!!busy} onClick={() => put(x)} aria-label={`Restore ${x.name}`}>{busy === x.id ? 'Restoring…' : 'Restore'}</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
