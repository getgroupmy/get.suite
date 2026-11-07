// The bell in the top bar: what needs you (mentions, tasks given to you, invitations, things shared
// with you, bookings), newest first. Opening one marks it read and goes there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, onLive } from '../api.js';
import Icon from './Icon.jsx';

const ICONS = { mention: 'chat', comment: 'chat', task: 'check', invite: 'calendar', share: 'share', booking: 'calendar' };

/** "just now", "5 min", "3 h", "yesterday", "2 Nov". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function Bell() {
  const navigate = useNavigate();
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const box = useRef();
  const load = useCallback(() => get('/notifications').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => {
    if (m.type === 'notification') setData((d) => ({ items: [m.notification, ...d.items.filter((x) => x.id !== m.notification.id)].slice(0, 100), unread: d.unread + 1 }));
    else if (m.type === 'notifications-read' || m.type === 'live-connected') load();
  }), [load]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const go = async (n) => {
    setOpen(false);
    if (!n.read) post('/notifications/read', { ids: [n.id] }).then(setData).catch(() => {});
    if (n.link) navigate(n.link);
  };
  return (
    <div className="bell" ref={box}>
      <button type="button" className="icon-btn bell-btn" aria-label={data.unread ? `Notifications, ${data.unread} new` : 'Notifications'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />{data.unread > 0 && <span className="badge" aria-hidden="true">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="row bell-head"><strong className="grow">Notifications</strong>
            {data.unread > 0 && <button type="button" className="link-btn small" onClick={() => post('/notifications/read', { all: true }).then(setData)}>Mark all read</button>}</div>
          {data.items.length === 0 ? <p className="muted small bell-empty">Nothing yet. Mentions, tasks given to you, invitations and things shared with you will show here.</p> : (
            <ul>
              {data.items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={`bell-item ${n.read ? '' : 'unread'}`} onClick={() => go(n)}>
                    <Icon name={ICONS[n.kind] || 'bell'} size={18} />
                    <span className="grow"><span className="bell-title">{n.title}</span>{n.body && <span className="muted small bell-body">{n.body}</span>}</span>
                    <span className="muted small nowrap">{ago(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
