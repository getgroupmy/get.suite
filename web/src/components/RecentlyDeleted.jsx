// Recently deleted task lists or forms (yours), each with Restore: they're kept 30 days (server/src/recyclebin.js).
// Tick several to restore them together.
import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { Empty, Modal, useToast } from './ui.jsx';

const when = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });

export default function RecentlyDeleted({ title, list, restore, what, note, onRestored, onClose }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  useEffect(() => { get(list).then(setItems).catch((e) => toast(e.message, 'error')); }, [list, toast]);
  const put = async (x) => {
    if (busy) return;
    setBusy(x.id);
    try { const r = await post(restore(x.id)); toast(`“${x.name}” is back`); onRestored(r); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  // The ticked ones, one after another; what came back is said even if one then fails. Opens the last one back.
  const putMany = async () => {
    if (busy) return;
    setBusy('many');
    const chosen = (items || []).filter((x) => picked.has(x.id));
    let n = 0, last = null;
    try {
      for (const x of chosen) { last = await post(restore(x.id)); n++; }
      toast(`${n} ${what.toLowerCase()} are back`);
      onRestored(last);
    } catch (e) {
      toast(n ? `${n} back; then: ${e.message}` : e.message, 'error');
      get(list).then(setItems).catch(() => {}); setPicked(new Set());
    } finally { setBusy(null); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>{note || `${what} you delete are kept here for 30 days, then deleted for good. Restoring brings back everything in them, for everyone they were shared with.`}</p>
      {items === null ? <p className="muted">Loading…</p> : !items.length ? <Empty icon="trash" title="Nothing deleted lately" /> : (<>
        {items.length > 1 && (
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <label className="check small grow"><input type="checkbox" aria-label="Select all deleted" checked={items.every((x) => picked.has(x.id))} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((x) => x.id)) : new Set())} /> Select all</label>
            <button type="button" className="btn small primary" disabled={!picked.size || !!busy} onClick={putMany}>{busy === 'many' ? 'Restoring…' : `Restore ${picked.size || ''}`.trim()}</button>
          </div>
        )}
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={title}>
          {items.map((x) => (
            <li key={x.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {items.length > 1 && <input type="checkbox" aria-label={`Select ${x.name || 'Untitled'}`} checked={picked.has(x.id)} onChange={(e) => { const s = new Set(picked); e.target.checked ? s.add(x.id) : s.delete(x.id); setPicked(s); }} />}
              <span className="grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{x.name || 'Untitled'}</strong> <span className="muted small">deleted {when(x.deleted_at)} · kept until {when(x.until)}</span></span>
              <button type="button" className="btn small" disabled={!!busy} onClick={() => put(x)} aria-label={`Restore ${x.name}`}>{busy === x.id ? 'Restoring…' : 'Restore'}</button>
            </li>
          ))}
        </ul>
      </>)}
    </Modal>
  );
}
