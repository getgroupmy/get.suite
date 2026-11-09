// The bell in the top bar: what needs you (mentions, tasks given to you, invitations, things shared
// with you, bookings), newest first. Opening one marks it read and goes there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, put, onLive } from '../api.js';
import Icon from './Icon.jsx';
import { Modal, useToast } from './ui.jsx';

const ICONS = { mention: 'chat', comment: 'chat', task: 'check', invite: 'calendar', share: 'share', booking: 'calendar', edit: 'edit', chat: 'chat', form: 'form' };

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
  const [settings, setSettings] = useState(false);
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
            {data.unread > 0 && <button type="button" className="link-btn small" onClick={() => post('/notifications/read', { all: true }).then(setData)}>Mark all read</button>}
            <button type="button" className="icon-btn" aria-label="Notification settings" title="Choose what you're notified about" onClick={() => { setOpen(false); setSettings(true); }}><Icon name="settings" size={18} /></button></div>
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
      {settings && <NotificationSettings onClose={() => setSettings(false)} />}
    </div>
  );
}

/** Which kinds of notification you get (each on or off). */
function NotificationSettings({ onClose }) {
  const toast = useToast();
  const [kinds, setKinds] = useState(null);
  useEffect(() => { get('/notifications/settings').then((r) => setKinds(r.kinds)).catch((e) => toast(e.message, 'error')); }, [toast]);
  const toggle = async (kind) => {
    const next = kinds.map((k) => (k.kind === kind ? { ...k, on: !k.on } : k));
    setKinds(next);
    try { setKinds((await put('/notifications/settings', { off: next.filter((k) => !k.on).map((k) => k.kind) })).kinds); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title="Notification settings" onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>What shows in the bell (and pops up, and on your desktop). Turned-off kinds aren't kept, so they won't appear later either.</p>
        {kinds?.map((k) => <label key={k.kind} className="check"><input type="checkbox" checked={k.on} onChange={() => toggle(k.kind)} /> {k.label}</label>)}
        <ThisDevice />
        <div className="row end"><button type="button" className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

// Base64url (the push service's key) as the bytes PushManager wants.
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));

/**
 * Notifications on this device, even with Workspace closed (phones with Workspace installed, and
 * computers): turned on per device; needs HTTPS and the browser's permission.
 */
function ThisDevice() {
  const toast = useToast();
  const [state, setState] = useState('checking'); // checking | unsupported | blocked | off | on
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const current = useCallback(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription()), []);
  useEffect(() => {
    if (!supported) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('blocked'); return; }
    current().then((s) => setState(s ? 'on' : 'off')).catch(() => setState('off'));
  }, [supported, current]);
  const turnOn = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { setState('blocked'); return; }
      const { publicKey } = await get('/push');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await post('/push/subscribe', sub.toJSON());
      await post('/push/test');
      setState('on');
      toast('Notifications are on for this device');
    } catch (e) { toast(e.message || 'Couldn’t turn notifications on', 'error'); }
    finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true);
    try { const s = await current(); if (s) { await post('/push/unsubscribe', { endpoint: s.endpoint }); await s.unsubscribe(); } setState('off'); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <strong>On this device, even with Workspace closed</strong>
      {state === 'unsupported' && <p className="muted small" style={{ margin: 0 }}>Not available here: it needs Workspace over HTTPS, and on iPhone and iPad, Workspace added to the Home Screen first (Share → Add to Home Screen).</p>}
      {state === 'blocked' && <p className="muted small" style={{ margin: 0 }}>Notifications are blocked for Workspace in this browser. Allow them in the browser's site settings, then come back here.</p>}
      {state === 'off' && <div className="row"><button type="button" className="btn" disabled={busy} onClick={turnOn}>Turn on notifications on this device</button></div>}
      {state === 'on' && <div className="row"><span className="grow small">On: what lands in the bell reaches this device too (not while notifications are paused or in your quiet hours).</span><button type="button" className="btn" disabled={busy} onClick={turnOff}>Turn off</button></div>}
    </div>
  );
}
