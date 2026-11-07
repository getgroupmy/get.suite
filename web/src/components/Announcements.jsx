// Company announcements at the top of Workspace: each one until you dismiss it (or it ends).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { get, post, onLive } from '../api.js';
import Icon from './Icon.jsx';

export default function Announcements() {
  const [list, setList] = useState([]);
  const load = useCallback(() => get('/announcements').then(setList).catch(() => {}), []);
  useEffect(() => { load(); return onLive((m) => { if (m.type === 'announcements-changed' || m.type === 'live-connected') load(); }); }, [load]);
  if (!list.length) return null;
  return (
    <div className="announcements" role="region" aria-label="Announcements">
      {list.map((a) => (
        <div key={a.id} className={`announcement ${a.tone === 'warn' ? 'warn' : ''}`}>
          <span aria-hidden="true">{a.tone === 'warn' ? '⚠️' : '📣'}</span>
          <span className="grow">{a.text}{a.author_name && <span className="muted small"> · {a.author_name}</span>}
            {a.link && (a.link.startsWith('/') ? <> <Link to={a.link}>Open</Link></> : <> <a href={a.link} target="_blank" rel="noopener noreferrer">Open</a></>)}</span>
          <button type="button" className="icon-btn" aria-label={`Dismiss: ${a.text}`} title="Dismiss" onClick={() => post(`/announcements/${a.id}/dismiss`).then(load).catch(() => {})}><Icon name="close" size={16} /></button>
        </div>
      ))}
    </div>
  );
}
