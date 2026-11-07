// Version history inside an editor: earlier versions newest first (named ones marked), a preview
// of the one picked, restoring it (what's there now is kept as a version too), and naming
// versions so they're kept for good. Each editor gives its own preview of a version's content.
import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, onLive } from '../api.js';
import { Modal, useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function VersionHistory({ file, canEdit, renderPreview, onClose }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState(null); // { v, content }
  const [naming, setNaming] = useState(null); // 'current' | version
  const [label, setLabel] = useState('');
  const load = useCallback(() => get(`/files/${file.id}/versions`).then(setList).catch((e) => toast(e.message, 'error')), [file.id, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'versions-changed' && m.id === file.id) load(); }), [file.id, load]);

  const pick = async (v) => {
    try { const r = await get(`/files/${file.id}/versions/${v.id}/content`); setPicked({ v, content: r.content }); }
    catch (e) { toast(e.message, 'error'); }
  };
  const restore = async () => {
    try { await post(`/files/${file.id}/versions/${picked.v.id}/restore`); toast(`Restored the version from ${when(picked.v.saved_at)}`); onClose(); }
    catch (e) { toast(e.message, 'error'); }
  };
  async function saveName(e) {
    e.preventDefault();
    try {
      if (naming === 'current') await post(`/files/${file.id}/versions/name`, { label });
      else await patch(`/files/${file.id}/versions/${naming.id}`, { label });
      toast(label.trim() ? `Named “${label.trim()}”` : 'Name removed');
      setNaming(null); setLabel(''); load();
      if (picked && naming !== 'current' && picked.v.id === naming.id) setPicked({ ...picked, v: { ...picked.v, label: label.trim() || null } });
    } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <Modal wide title="Version history" onClose={onClose}>
      <div className="versions">
        <aside className="versions-list">
          {canEdit && <button type="button" className="btn small" onClick={() => { setNaming('current'); setLabel(''); }}><Icon name="edit" size={16} /> Name current version</button>}
          {naming && (
            <form className="stack versions-name" onSubmit={saveName}>
              <label className="field"><span>{naming === 'current' ? 'Name for the file as it is now' : 'Name for this version (empty: no name)'}</span>
                <input autoFocus maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sent to the client" /></label>
              <div className="row"><button type="button" className="btn small" onClick={() => setNaming(null)}>Cancel</button><button className="btn small primary" disabled={naming === 'current' && !label.trim()}>Save</button></div>
            </form>
          )}
          {list && !list.length && <p className="muted small">No earlier versions yet. One is kept each time someone else edits, or after a break.</p>}
          <ul aria-label="Versions">
            {(list || []).map((v) => (
              <li key={v.id}>
                <button type="button" className={`version-item ${picked?.v.id === v.id ? 'on' : ''}`} onClick={() => pick(v)}>
                  {v.label && <strong className="version-label">{v.label}</strong>}
                  <span>{when(v.saved_at)}</span>
                  <span className="muted small">{v.saved_by_name || 'Someone'}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="versions-preview" aria-label="Preview">
          {!picked ? <p className="muted versions-hint">Pick a version to see it.</p> : <>
            <div className="row versions-bar">
              <span className="grow"><strong>{picked.v.label || when(picked.v.saved_at)}</strong>{picked.v.label && <span className="muted small"> · {when(picked.v.saved_at)}</span>}</span>
              {canEdit && <button type="button" className="btn small" onClick={() => { setNaming(picked.v); setLabel(picked.v.label || ''); }}>{picked.v.label ? 'Rename' : 'Name this version'}</button>}
              {canEdit && <button type="button" className="btn small primary" onClick={restore}>Restore this version</button>}
            </div>
            <div className="versions-body">{renderPreview(picked.content)}</div>
          </>}
        </section>
      </div>
    </Modal>
  );
}
