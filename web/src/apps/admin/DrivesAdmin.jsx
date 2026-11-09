// Admin → Shared drives: every shared drive in the company, who owns it, how many people are in it
// and how big it is. An admin who isn't in one can add themselves as an editor (to look after a
// drive whose people have moved on, say); its owner is told, and it's in the activity log.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, useToast } from '../../components/ui.jsx';

export default function DrivesAdmin({ orgId, orgPicker }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [drives, setDrives] = useState(null);
  const [joining, setJoining] = useState(null);
  const qs = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
  const load = useCallback(() => get(`/orgs/current/drives${qs}`).then(setDrives).catch((e) => toast(e.message, 'error')), [qs, toast]);
  useEffect(() => { setDrives(null); load(); }, [load]);
  return (
    <div className="stack" style={{ maxWidth: 1000 }}>
      {orgPicker}
      <p className="muted small" style={{ margin: 0 }}>Shared drives belong to teams rather than to one person; people make them in Drive → Shared drives. You only see what's inside the ones you're in.</p>
      {drives === null ? <p className="muted">Loading…</p> : !drives.length ? <p className="muted">No shared drives yet.</p> : (
        <div className="card" style={{ padding: 0 }}>
          <table className="files">
            <caption className="sr-only">Shared drives</caption>
            <thead><tr><th>Name</th><th className="hide-sm">Owner</th><th className="num">People</th><th className="num hide-sm">Files</th><th className="num">Size</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {drives.map((d) => (
                <tr key={d.id}>
                  <td className="name"><Icon name="people" /><span>{d.name}</span></td>
                  <td className="hide-sm muted">{d.owner_name}</td>
                  <td className="num">{d.members}</td>
                  <td className="num hide-sm">{d.items}</td>
                  <td className="num">{formatBytes(d.size)}</td>
                  <td className="actions">
                    {d.my_role
                      ? <button className="btn" onClick={() => navigate(`/drive/folder/${d.id}`)} aria-label={`Open ${d.name}`}>Open</button>
                      : <button className="btn" onClick={() => setJoining(d)} aria-label={`Add me to ${d.name}`}>Add me</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {joining && (
        <ConfirmModal title={`Add yourself to “${joining.name}”?`} confirm="Add me as an editor" danger={false}
          message={`You'll see everything in it and can manage its members. ${joining.owner_name} is told, and it's recorded in the activity log.`}
          onClose={() => setJoining(null)} onConfirm={async () => { await post(`/orgs/current/drives/${joining.id}/join${qs}`); toast(`You're an editor of ${joining.name}`); load(); }} />
      )}
    </div>
  );
}
