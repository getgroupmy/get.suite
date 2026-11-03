// New-mail notifications: while someone has Workspace open (a live WebSocket), keep one extra
// IMAP connection on their Inbox in IDLE mode. Dovecot tells us immediately when mail arrives,
// and we push { type: 'mail-new' } and { type: 'mail-unread' } to their browser tabs.
import { ImapFlow } from 'imapflow';
import { q } from '../db.js';
import { sendTo, onPresence } from '../hub.js';
import { webmailSecret, mailEnabled } from './config.js';
import { IMAP_SETTINGS } from './imap.js';

const LINGER_MS = Number(process.env.MAIL_NOTIFY_LINGER_MS || 60e3); // keep watching briefly after the last tab closes
const watchers = new Map(); // userId -> { client, stopTimer, retry, stopped }

// SEARCH, not STATUS: for the folder that is open on this connection STATUS may report stale numbers.
async function unseenCount(client) {
  return ((await client.search({ seen: false }, { uid: true })) || []).length;
}

async function connect(userId, w) {
  const user = q('SELECT id, username, disabled FROM users WHERE id = ?').get(userId);
  if (!user || user.disabled) return;
  const client = new ImapFlow({
    ...IMAP_SETTINGS,
    auth: { user: `${user.username}*webmail`, pass: webmailSecret() },
    logger: false, emitLogs: false,
    maxIdleTime: 10 * 60e3, // re-issue IDLE regularly so NAT/firewalls don't drop the connection
  });
  w.client = client;
  client.on('error', () => {});
  client.on('close', () => {
    if (w.client !== client || w.stopped) return;
    // Mail server restarted or the connection dropped: reconnect with backoff while the user is online.
    w.retry = Math.min((w.retry || 0) + 1, 6);
    setTimeout(() => { if (!w.stopped) connect(userId, w).catch(() => {}); }, 1000 * 2 ** w.retry).unref();
  });
  client.on('exists', async ({ count, prevCount }) => {
    if (count <= prevCount) return;
    try {
      const fresh = [];
      for await (const m of client.fetch(`${Math.max(prevCount + 1, count - 4)}:${count}`, { uid: true, envelope: true, flags: true })) {
        if (!m.flags.has('\\Seen')) fresh.push(m);
      }
      for (const m of fresh) {
        const from = m.envelope?.from?.[0];
        sendTo([userId], { type: 'mail-new', folder: 'INBOX', uid: m.uid, subject: m.envelope?.subject || '', from: from ? { name: from.name || '', address: from.address || '' } : null });
      }
      sendTo([userId], { type: 'mail-unread', unseen: await unseenCount(client) });
    } catch { /* the next event or the 30 s refresh in the app will catch up */ }
    rearm();
  });
  // Mail read, deleted or moved elsewhere (another tab, a phone): refresh the unread badge.
  let flagTimer = null;
  const pushUnread = () => {
    clearTimeout(flagTimer);
    flagTimer = setTimeout(async () => {
      try { sendTo([userId], { type: 'mail-unread', unseen: await unseenCount(client) }); } catch {}
      rearm();
    }, 300);
  };
  client.on('flags', pushUnread);
  client.on('expunge', pushUnread);
  // ImapFlow only enters IDLE by itself after a quiet period; start it right away (and again after
  // every fetch), so arrivals are reported immediately instead of up to ~15 s later.
  const rearm = () => { if (client.usable && !w.stopped) client.idle().catch(() => {}); };
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true }); // only watching; never changes flags
    w.retry = 0;
    sendTo([userId], { type: 'mail-unread', unseen: await unseenCount(client) });
    rearm();
  } catch {
    try { client.close(); } catch {}
  }
}

export function watch(userId) {
  let w = watchers.get(userId);
  if (w) { clearTimeout(w.stopTimer); w.stopTimer = null; return; }
  w = { client: null, stopTimer: null, retry: 0, stopped: false };
  watchers.set(userId, w);
  connect(userId, w).catch(() => {});
}

export function unwatch(userId, delay = LINGER_MS) {
  const w = watchers.get(userId);
  if (!w || w.stopTimer) return;
  w.stopTimer = setTimeout(() => {
    w.stopped = true;
    watchers.delete(userId);
    w.client?.logout().catch(() => {});
  }, delay);
  w.stopTimer.unref?.();
}

export const watchingCount = () => watchers.size;

export function startMailNotifications() {
  if (!mailEnabled()) return;
  onPresence((userId, online) => (online ? watch(userId) : unwatch(userId)));
}

export function stopAll() {
  for (const [id, w] of watchers) { w.stopped = true; clearTimeout(w.stopTimer); w.client?.logout().catch(() => {}); watchers.delete(id); }
}
