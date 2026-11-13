// Drive → Shared by link: every link you've made for people without an account, on any file or folder, with until
// when it works, whether it has a password and how often it was opened. Copy it, open its Share window, or stop it.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, del, formatDate, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Empty, useToast } from '../../components/ui.jsx';
import { linkUrl } from './Drive.jsx';

export default function MyLinks() {
  const toast = useToast();
  const navigate = useNavigate();
  const [links, setLinks] = useState(null);
  const [expired, setExpired] = useState(false);
  const load = useCallback(() => get(`/links/mine${expired ? '?expired=1' : ''}`).then(setLinks).catch((e) => toast(e.message, 'error')), [expired, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'notification') load(); }), [load]);
  const copy = async (l) => { try { await navigator.clipboard.writeText(linkUrl(l.token)); toast('Link copied'); } catch { toast(linkUrl(l.token)); } };
  const stop = async (l) => { try { await del(`/links/${l.id}`); toast('Link removed: it no longer works'); load(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>Links you’ve made for people without an account (Share → Link sharing). Open one’s Share window to change its expiry or password.</p>
      <label className="check"><input type="checkbox" checked={expired} onChange={(e) => setExpired(e.target.checked)} /> Show expired links too</label>
      {links === null ? <p className="muted">Loading…</p> : !links.length ? <Empty icon="link" title="No links">{expired ? 'You haven’t made any.' : 'None of your links is working now.'} Make one from a file’s Share window.</Empty> : (
        <table className="files">
          <caption className="sr-only">Your share links</caption>
          <thead><tr><th>File or folder</th><th>Kind</th><th className="hide-sm">Works until</th><th className="num hide-sm">Opened</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} className={l.expired ? 'muted' : ''}>
                <td className="name"><Icon name={l.file_kind === 'folder' ? 'folder' : 'file'} /><span>{l.file_name}{l.trashed && <span className="muted small"> (in the trash)</span>}</span></td>
                <td>{l.mode === 'upload' ? 'File request' : 'View and download'}{l.has_password && <span className="muted small"> · 🔑</span>}{l.notify_open && <span className="muted small"> · 🔔</span>}</td>
                <td className="hide-sm">{l.expired ? 'Expired' : l.expires_at ? formatDate(l.expires_at) : 'No expiry'}</td>
                <td className="num hide-sm">{l.opens || 0}</td>
                <td className="actions">
                  {!l.expired && <button type="button" className="icon-btn" aria-label={`Copy the link to ${l.file_name}`} title="Copy link" onClick={() => copy(l)}><Icon name="copy" size={18} /></button>}
                  <button type="button" className="btn small" aria-label={`Share settings for ${l.file_name}`} onClick={() => navigate(`/drive?share=${l.file_id}`)}>Share…</button>
                  <button type="button" className="icon-btn" aria-label={`Remove the link to ${l.file_name}`} title="Remove link" onClick={() => stop(l)}><Icon name="close" size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
