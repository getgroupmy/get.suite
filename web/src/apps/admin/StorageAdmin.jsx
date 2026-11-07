// Admin → Storage: how full the company's storage is, who uses what (files, the earlier versions
// kept of them, and the trash), and the largest files, to see where space goes.
import { useEffect, useState } from 'react';
import { get, formatBytes } from '../../api.js';
import { Avatar, useToast } from '../../components/ui.jsx';
import { fileIcon } from '../../components/Icon.jsx';
import Icon from '../../components/Icon.jsx';

const Bar = ({ value, max, warn }) => (
  <div className={`usage-bar ${warn ? 'warn' : ''}`} aria-hidden="true"><div style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} /></div>
);

export default function StorageAdmin({ orgId, orgPicker }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  useEffect(() => { setData(null); get(`/orgs/current/storage${orgId ? `?org_id=${encodeURIComponent(orgId)}` : ''}`).then(setData).catch((e) => toast(e.message, 'error')); }, [orgId, toast]);
  if (!data) return orgPicker || null;
  const quota = data.quota_mb ? data.quota_mb * 1024 * 1024 : null;
  const most = Math.max(1, ...data.people.map((p) => p.total));
  const trash = data.people.reduce((n, p) => n + p.trash, 0), versions = data.people.reduce((n, p) => n + p.versions, 0);
  return (
    <div className="stack" style={{ maxWidth: 1000 }}>
      {orgPicker}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{formatBytes(data.used)} used{quota ? ` of ${formatBytes(quota)}` : ''}</h2>
        {quota && <Bar value={data.used} max={quota} warn={data.used > quota * 0.9} />}
        <p className="muted small" style={{ margin: 0 }}>
          {quota ? `${Math.round((data.used / quota) * 100)}% of the company's storage. ` : 'No storage limit is set for this company. '}
          Earlier versions take {formatBytes(versions)} and the trash {formatBytes(trash)}; people can empty their trash in Drive, and versions can be deleted from a file's version history.
        </p>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table className="files storage-table">
          <caption className="sr-only">Storage by person</caption>
          <thead><tr><th>Person</th><th className="num">Files</th><th className="num hide-sm">Versions</th><th className="num hide-sm">Trash</th><th className="num">Total</th><th className="hide-sm" aria-label="Share" /></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.id}>
                <td className="name"><Avatar name={p.name} size={26} userId={p.id} /><span>{p.name}<span className="muted small"> {p.username}</span></span></td>
                <td className="num">{formatBytes(p.files)} <span className="muted small">· {p.count}</span></td>
                <td className="num hide-sm muted">{formatBytes(p.versions)}</td>
                <td className="num hide-sm muted">{formatBytes(p.trash)}</td>
                <td className="num"><strong>{formatBytes(p.total)}</strong></td>
                <td className="hide-sm" style={{ width: 160 }}><Bar value={p.total} max={most} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack" style={{ padding: 0 }}>
        <h3 style={{ margin: '14px 16px 0' }}>Largest files</h3>
        <table className="files">
          <thead><tr><th>File</th><th className="hide-sm">Owner</th><th className="num">Size</th><th className="num hide-sm">With versions</th></tr></thead>
          <tbody>
            {data.largest.map((f) => (
              <tr key={f.id}>
                <td className="name"><Icon name={fileIcon(f)} size={20} /><span>{f.name}{f.trashed && <span className="pill off" style={{ marginLeft: 6 }}>In trash</span>}</span></td>
                <td className="hide-sm muted">{f.owner_name}</td>
                <td className="num">{formatBytes(f.size)}</td>
                <td className="num hide-sm muted">{formatBytes(f.size + f.versions_size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
