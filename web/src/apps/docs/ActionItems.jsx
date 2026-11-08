// "Send action items to Tasks" (Docs): the unticked checklist items that mention someone, each to
// become a task for that person linking back here. Items already sent are marked and left alone.
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { localToday, dueLabel } from '../tasks/taskmath.js';
import { actionItems } from './actionitems.js';

const keyOf = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

export function ActionItemsDialog({ fileId, doc, onClose }) {
  const toast = useToast();
  const [items] = useState(() => actionItems(doc, localToday()));
  const [sent, setSent] = useState(null); // Map "user|key" → done
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const idOf = (it) => `${it.user_id}|${keyOf(it.text)}`;
  useEffect(() => {
    get(`/tasks/from-doc/${fileId}`).then((list) => {
      const m = new Map(list.map((x) => [`${x.user_id}|${x.key}`, x.done]));
      setSent(m);
      setPicked(new Set(items.filter((it) => !m.has(idOf(it))).map(idOf)));
    }).catch(() => { setSent(new Map()); setPicked(new Set(items.map(idOf))); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);
  const send = async () => {
    setBusy(true);
    try {
      const r = await post(`/tasks/from-doc/${fileId}`, { items: items.filter((it) => picked.has(idOf(it))) });
      const cant = [...new Set(r.made.filter((x) => !x.can_open).map((x) => x.name))];
      toast(`${r.made.length ? `Sent ${r.made.length} task${r.made.length === 1 ? '' : 's'}` : 'Nothing new to send'}${r.already.length ? ` (${r.already.length} already sent)` : ''}${cant.length ? `. ${cant.join(', ')} can't open this document: share it so the link works.` : ''}`);
      onClose();
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Send action items to Tasks" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      {items.length > 0 && <button type="button" className="btn primary" disabled={busy || !picked.size} onClick={send}>Send {picked.size || ''}</button>}
    </>}>
      {!items.length ? <p className="muted">No action items yet. Make a checklist item that mentions someone, like “☐ @Kim send the figures by Friday”, and it can become a task for them.</p> : <>
        <p className="muted small" style={{ marginTop: 0 }}>Each becomes a task in that person's Tasks, given by you, with a link back to this document. A date in it becomes the due date.</p>
        <ul className="action-items" aria-label="Action items">
          {items.map((it) => {
            const id = idOf(it), was = sent?.has(id);
            return (
              <li key={id}>
                <label className="check">
                  <input type="checkbox" disabled={was} checked={picked.has(id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} />
                  <span><strong>{it.name}</strong>: {it.title}{it.due && <span className="muted"> · {dueLabel(it.due, new Date(), it.due_time).text}</span>}
                    {was && <span className="muted small"> · {sent.get(id) ? 'done ✓' : 'already sent'}</span>}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </>}
    </Modal>
  );
}
