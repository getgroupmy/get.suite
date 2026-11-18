// The bell in the top bar: what needs you (mentions, tasks given to you, invitations, things shared
// with you, bookings), newest first. Opening one marks it read and goes there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, put, onLive } from '../api.js';
import Icon from './Icon.jsx';
import { setBadgePart } from '../appbadge.js';
import { Avatar, Modal, useToast } from './ui.jsx';
import { snoozeTimes } from './snooze.js';

const ICONS = { mention: 'chat', comment: 'chat', reply: 'reply', task: 'check', invite: 'calendar', share: 'share', link: 'link', booking: 'calendar', edit: 'edit', chat: 'chat', form: 'form' };

/** "just now", "5 min", "3 h", "yesterday", "2 Nov". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const untilText = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function Bell() {
  const navigate = useNavigate();
  const [data, setData] = useState({ items: [], unread: 0, snoozed: [] });
  const [snoozeFor, setSnoozeFor] = useState(null); // the notification whose snooze times are showing
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [openGroup, setOpenGroup] = useState(null); // the grouped notification opened up to show what's in it
  useEffect(() => { setBadgePart('bell', data.unread); }, [data.unread]); // on the app's icon, with unread mail
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const shown = onlyUnread ? data.items.filter((n) => !n.read) : data.items;
  const toast = useToast();
  // Taken out of the bell, with Undo (for 10 minutes on the server; the message shows a while).
  const remove = (body) => post('/notifications/remove', body).then((d) => {
    setData(d);
    if (!d.removed?.length) return;
    toast(d.removed.length === 1 ? 'Notification removed' : `${d.removed.length} notifications removed`, 'info', { action: { label: 'Undo', onClick: () => post('/notifications/restore', { ids: d.removed }).then(setData).catch((e) => toast(e.message, 'error')) } });
  }).catch((e) => toast(e.message, 'error'));
  const act = (path, n, extra = {}) => post(path, { ids: [n.id], ...extra }).then(setData).catch((e) => toast(e.message, 'error'));
  const box = useRef();
  // A list asked for before a live notification arrived would drop it: each load is numbered, only the latest
  // one asked for is shown, and one asked for before live news came is asked for again.
  const issued = useRef(0), newsAfter = useRef(0);
  const load = useCallback(() => {
    const n = ++issued.current;
    return get('/notifications').then((d) => {
      if (n !== issued.current) return; // a newer one is on its way
      if (n <= newsAfter.current) { load(); return; } // live news arrived while this was on its way
      setData(d);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => {
    if (m.type === 'notification') newsAfter.current = issued.current;
    if (m.type === 'notification') setData((d) => ({ ...d, snoozed: (d.snoozed || []).filter((x) => x.id !== m.notification.id), items: [m.notification, ...d.items.filter((x) => x.id !== m.notification.id && x.id !== m.replaces)].slice(0, 100), unread: d.unread + (m.replaces && d.items.some((x) => x.id === m.replaces && !x.read) ? 0 : 1) })); // replaces: a grouped one counting more now
    else if (m.type === 'notifications-read' || m.type === 'live-connected') load();
  }), [load]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target) && !e.target.closest?.('.toasts')) setOpen(false); }; // (Undo on a message about it keeps it open)
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
          <div className="bell-head">
            <div className="row"><strong className="grow">Notifications</strong>
              <button type="button" className="icon-btn" aria-label="Notification settings" title="Choose what you're notified about" onClick={() => { setOpen(false); setSettings(true); }}><Icon name="settings" size={18} /></button></div>
            <div className="row bell-tools">
              <button type="button" className={`btn small ${onlyUnread ? 'primary' : ''}`} aria-pressed={onlyUnread} onClick={() => setOnlyUnread(!onlyUnread)}>Unread only</button>
              <span className="grow" />
              {data.items.some((n) => n.read) && <button type="button" className="link-btn small" title="Remove every notification you’ve read" onClick={() => remove({ read: true })}>Clear read</button>}
              {data.unread > 0 && <button type="button" className="link-btn small" onClick={() => post('/notifications/read', { all: true }).then(setData)}>Mark all read</button>}
            </div>
          </div>
          {shown.length === 0 ? <p className="muted small bell-empty">{onlyUnread && data.items.length ? 'Nothing unread.' : 'Nothing yet. Mentions, tasks given to you, invitations and things shared with you will show here.'}</p> : (
            <ul>
              {shown.map((n) => (
                <li key={n.id} className={n.items?.length > 1 ? 'bell-group' : ''}>
                  <button type="button" className={`bell-item ${n.read ? '' : 'unread'}`} onClick={() => go(n)}>
                    {/* who did it, where there's someone (their name is in the title, so the picture is decoration) */}
                    {n.actor ? <span className="bell-who" aria-hidden="true"><Avatar name={n.actor} size={24} /><Icon name={ICONS[n.kind] || 'bell'} size={12} className="bell-kind" /></span> : <Icon name={ICONS[n.kind] || 'bell'} size={18} />}
                    <span className="grow"><span className="bell-title">{n.title}</span>{n.body && <span className="muted small bell-body">{n.body}</span>}</span>
                    <span className="muted small nowrap">{ago(n.created_at)}</span>
                  </button>
                  {/* On hover or focus (always on touch screens): back to unread or read, and remove. */}
                  <span className={`bell-acts${snoozeFor === n.id ? ' open' : ''}`}>
                    <button type="button" className="icon-btn" aria-label={`Snooze: ${n.title}`} title="Snooze" aria-expanded={snoozeFor === n.id}
                      onClick={() => setSnoozeFor(snoozeFor === n.id ? null : n.id)}><Icon name="clock" size={16} /></button>
                    <button type="button" className="icon-btn" aria-label={`${n.read ? 'Mark as unread' : 'Mark as read'}: ${n.title}`} title={n.read ? 'Mark as unread' : 'Mark as read'}
                      onClick={() => act(n.read ? '/notifications/unread' : '/notifications/read', n)}><Icon name={n.read ? 'markunread' : 'check'} size={16} /></button>
                    <button type="button" className="icon-btn" aria-label={`Remove: ${n.title}`} title="Remove" onClick={() => remove({ ids: [n.id] })}><Icon name="close" size={16} /></button>
                  </span>
                  {snoozeFor === n.id && (
                    <div className="bell-snooze" role="group" aria-label="Snooze until">
                      {snoozeTimes().map((t) => (
                        <button key={t.label} type="button" className="bell-snooze-opt" onClick={() => { setSnoozeFor(null); act('/notifications/snooze', n, { until: t.at }).then(() => toast(`Snoozed until ${untilText(t.at)}`)); }}>
                          <span className="grow">{t.label}</span><span className="muted small">{t.when}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* A grouped one: open it up for each of them, each going to its own place. */}
                  {n.items?.length > 1 && (
                    <>
                      <button type="button" className="link-btn small bell-more" aria-expanded={openGroup === n.id} aria-controls={`bell-items-${n.id}`}
                        onClick={() => setOpenGroup(openGroup === n.id ? null : n.id)}>{openGroup === n.id ? 'Hide them' : `Show ${n.items.length === (n.group_n || n.items.length) ? `all ${n.items.length}` : `the latest ${n.items.length}`}`}</button>
                      {openGroup === n.id && (
                        <ul id={`bell-items-${n.id}`} className="bell-items" aria-label={`In “${n.title}”`}>
                          {n.items.map((it, i) => <li key={i}><button type="button" className="link-btn small" onClick={() => go({ ...n, link: it.link || n.link })}>{it.label}</button></li>)}
                        </ul>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* Snoozed ones: when each comes back, and Unsnooze to have it back now. */}
          {data.snoozed?.length > 0 && (
            <div className="bell-snoozed">
              <button type="button" className="link-btn small" aria-expanded={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)}>{showSnoozed ? 'Hide snoozed' : `Snoozed (${data.snoozed.length})`}</button>
              {showSnoozed && (
                <ul aria-label="Snoozed">
                  {data.snoozed.map((n) => (
                    <li key={n.id} className="row">
                      <span className="grow"><span className="bell-title">{n.title}</span><span className="muted small bell-body">Back {untilText(n.snoozed_until)}</span></span>
                      <button type="button" className="btn small" aria-label={`Unsnooze: ${n.title}`} onClick={() => act('/notifications/unread', n)}>Unsnooze</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
  const [devices, setDevices] = useState([]); // all your devices with notifications on
  const loadDevices = useCallback(async () => {
    let mine = '';
    try { if ('serviceWorker' in navigator) mine = (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.endpoint || ''; } catch { /* none */ }
    get(`/push${mine ? `?endpoint=${encodeURIComponent(mine)}` : ''}`).then((r) => setDevices(r.devices)).catch(() => {});
  }, []);
  useEffect(() => { loadDevices(); }, [loadDevices, state]);
  const removeDevice = async (d) => {
    if (d.this_device) return turnOff();
    try { await post('/push/remove', { id: d.id }); toast(`Notifications stopped on ${d.name}`); loadDevices(); } catch (e) { toast(e.message, 'error'); }
  };
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
      await post('/push/subscribe', { ...sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
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
      {devices.length > 0 && (
        <ul className="share-list" aria-label="Devices with notifications on">
          {devices.map((d) => (
            <li key={d.id} aria-label={d.name}>
              <span className="grow"><strong>{d.name}</strong>{d.this_device && <span className="muted small"> · this device</span>}
                <span className="muted small" style={{ display: 'block' }}>On since {new Date(d.created_at).toLocaleDateString()}{d.last_ok_at ? ` · last notified ${ago(d.last_ok_at)}` : ''}</span></span>
              <button type="button" className="link-btn small" onClick={() => removeDevice(d)} aria-label={`Stop notifications on ${d.name}${d.this_device ? ' (this device)' : ''}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
