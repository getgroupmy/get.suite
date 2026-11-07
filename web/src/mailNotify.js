// New-mail notifications: unread badge, tab title, in-app toast and (opt-in) desktop notifications.
// The server pushes { type: 'mail-new' } and { type: 'mail-unread' } over the live WebSocket.
import { useEffect, useState } from 'react';
import { isPaused } from './pause.js';
import { get, onLive } from './api.js';

const PREF = 'nw:desktop-notifications';
const store = {
  get: () => { try { return localStorage.getItem(PREF) === 'on'; } catch { return false; } },
  set: (on) => { try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* private mode: not remembered */ } },
};

export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const desktopOn = () => desktopSupported() && Notification.permission === 'granted' && store.get();

/** Ask the browser for permission; returns true when desktop notifications are now on. */
export async function enableDesktop() {
  if (!desktopSupported()) return false;
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  store.set(p === 'granted');
  return p === 'granted';
}
export function disableDesktop() { store.set(false); }

/** Shell-wide: returns the Inbox unread count and shows toasts/desktop notifications for new mail. */
export function useMailNotifications(enabled, { toast, openMessage }) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const load = () => get('/mail/unread').then((r) => setUnread(r.unseen)).catch(() => {});
    load();
    const onLocal = (e) => setUnread(e.detail);
    window.addEventListener('nw:unread', onLocal);
    const off = onLive((m) => {
      if (m.type === 'live-connected') load();
      if (m.type === 'mail-unread') setUnread(m.unseen);
      if (m.type === 'mail-new' && !isPaused()) {
        const who = m.from?.name || m.from?.address || 'someone';
        const where = m.folder && m.folder !== 'INBOX' ? ` in ${m.folder.split('/').join(' / ')}` : '';
        toast(`New mail${where} from ${who}: ${m.subject || '(no subject)'}`);
        if (desktopOn() && document.hidden) {
          try {
            const n = new Notification(where ? `${who}${where}` : who, { body: m.subject || '(no subject)', tag: `mail-${m.folder}-${m.uid}`, icon: '/favicon.svg' });
            n.onclick = () => { window.focus(); openMessage(m.folder, m.uid); n.close(); };
          } catch { /* some browsers only allow notifications from a service worker */ }
        }
      }
    });
    return () => { off(); window.removeEventListener('nw:unread', onLocal); };
  }, [enabled, toast, openMessage]);

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread]);

  return unread;
}
