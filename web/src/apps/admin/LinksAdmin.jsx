// Admin → Share links: every link for people without an account that someone in the company made (files and
// folders, and file requests), with who made it, until when it works, whether it has a password and how often it
// was opened. An admin can stop any of them; whoever made it is told.
import { useCallback, useEffect, useState } from 'react';
import { get, del, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, useToast } from '../../components/ui.jsx';

export default function LinksAdmin() {
  const toast = useToast();
  const [links, setLinks] = useState(null);
  const [expired, setExpired] = useState(false);
  const [stopping, setStopping] = useState(null);
  const load = useCallback(() => get(`/links/all${expired ? '?expired=1' : ''}`).then(setLinks).catch((e) => toast(e.message, 'error')), [expired, toast]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack" style={{ maxWidth: 1100 }}>
      <p className="muted small" style={{ margin: 0 }}>Links people in your company made for people without an account (Drive → Share → Link sharing). Stopping one makes it stop working at once; whoever made it is told. To stop them all, turn off <em>Links for people without an account</em> in Company settings.</p>
      <label className="check"><input type="checkbox" checked={expired} onChange={(e) => setExpired(e.target.checked)} /> Show expired links too</label>
      {links === null ? <p className="muted">Loading…</p> : !links.length ? <p className="muted">No {expired ? '' : 'working '}links.</p> : (
        <div className="card" style={{ padding: 0 }}>
          <table className="files">
            <caption className="sr-only">Share links</caption>
            <thead><tr><th>File or folder</th><th className="hide-sm">Made by</th><th>Kind</th><th className="hide-sm">Works until</th><th className="num hide-sm">Opened</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className={l.expired ? 'muted' : ''}>
                  <td className="name"><Icon name={l.file_kind === 'folder' ? 'folder' : 'file'} /><span>{l.file_name}{l.trashed && <span className="muted small"> (in the trash)</span>}</span></td>
                  <td className="hide-sm"><span title={l.owner_email}>{l.owner_name}</span></td>
                  <td>{l.mode === 'upload' ? 'File request' : 'View and download'}{l.has_password && <span className="muted small"> · 🔑 password</span>}</td>
                  <td className="hide-sm">{l.expired ? 'Expired' : l.expires_at ? formatDate(l.expires_at) : 'No expiry'}</td>
                  <td className="num hide-sm">{l.opens || 0}</td>
                  <td className="actions"><button className="btn" aria-label={`Stop the link to ${l.file_name} by ${l.owner_name}`} onClick={() => setStopping(l)}>Stop</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stopping && <ConfirmModal title="Stop this link?" danger confirm="Stop link"
        message={`The link to “${stopping.file_name}” that ${stopping.owner_name} made stops working at once. They'll be told.`}
        onConfirm={async () => { try { await del(`/links/${stopping.id}`); toast('Link stopped'); load(); } catch (e) { toast(e.message, 'error'); } }}
        onClose={() => setStopping(null)} />}
    </div>
  );
}
