// New-mail notifications: while someone has Workspace open (a live WebSocket), keep one IMAP
// connection in IDLE mode on each folder they follow (the Inbox, plus up to 10 they choose).
// Dovecot reports arrivals immediately; we push { type: 'mail-new' } and { type: 'mail-unread' }.
import { ImapFlow } from 'imapflow';
import { q } from '../db.js';
import { sendTo, onPresence } from '../hub.js';
import { webmailSecret, mailEnabled } from './config.js';
import { IMAP_SETTINGS } from './imap.js';

const LINGER_MS = Number(process.env.MAIL_NOTIFY_LINGER_MS || 60e3); // keep watching briefly after the last tab closes
export const MAX_FOLLOWED = 10;
const watchers = new Map(); // userId -> { stopTimer, stopped, folders: Map(path -> conn), counts: Map(path -> unseen) }

q(`CREATE TABLE IF NOT EXISTS notify_folders (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  folders TEXT NOT NULL            -- JSON list of folder paths, besides the Inbox
)`).run();

/** Folders a user gets notifications for: always the Inbox, then the ones they follow. */
export function followedFolders(userId) {
  const row = q('SELECT folders FROM notify_folders WHERE user_id = ?').get(userId);
  const extra = row ? JSON.parse(row.folders) : [];
  return ['INBOX', ...extra.filter((f) => f.toUpperCase() !== 'INBOX')];
}

/** Save the followed folders (without the Inbox) and, if the user is online, start/stop watchers to match. */
export function setFollowed(userId, folders) {
  const list = [...new Set(folders.filter((f) => f.toUpperCase() !== 'INBOX'))].slice(0, MAX_FOLLOWED);
  q(`INSERT INTO notify_folders (user_id, folders) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET folders = excluded.folders`).run(userId, JSON.stringify(list));
  const w = watchers.get(userId);
  if (w && !w.stopped) reconcile(userId, w);
  return followedFolders(userId);
}

// SEARCH, not STATUS: for the folder that is open on a connection STATUS may report stale numbers.
async function unseenCount(client) {
  return ((await client.search({ seen: false }, { uid: true })) || []).length;
}

function pushUnread(userId, w) {
  const byFolder = Object.fromEntries(w.counts);
  const unseen = Object.values(byFolder).reduce((a, b) => a + b, 0);
  sendTo([userId], { type: 'mail-unread', unseen, byFolder });
}

async function connectFolder(userId, w, path, conn) {
  const user = q('SELECT id, username, disabled FROM users WHERE id = ?').get(userId);
  if (!user || user.disabled) return;
  const client = new ImapFlow({
    ...IMAP_SETTINGS,
    auth: { user: `${user.username}*webmail`, pass: webmailSecret() },
    logger: false, emitLogs: false,
    maxIdleTime: 10 * 60e3, // re-issue IDLE regularly so NAT/firewalls don't drop the connection
  });
  conn.client = client;
  const live = () => !w.stopped && !conn.stopped && conn.client === client && w.folders.get(path) === conn;
  // ImapFlow only enters IDLE by itself after a quiet period; start it right away (and again after
  // every fetch), so arrivals are reported immediately instead of up to ~15 s later.
  const rearm = () => { if (client.usable && live()) client.idle().catch(() => {}); };
  const recount = async () => { w.counts.set(path, await unseenCount(client)); pushUnread(userId, w); };

  client.on('error', () => {});
  client.on('close', () => {
    if (!live()) return;
    // Mail server restarted or the connection dropped: reconnect with backoff while the user is online.
    conn.retry = Math.min((conn.retry || 0) + 1, 6);
    setTimeout(() => { if (live()) connectFolder(userId, w, path, conn).catch(() => {}); }, 1000 * 2 ** conn.retry).unref();
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
        sendTo([userId], { type: 'mail-new', folder: path, uid: m.uid, subject: m.envelope?.subject || '', from: from ? { name: from.name || '', address: from.address || '' } : null });
      }
      await recount();
    } catch { /* the next event or the 30 s refresh in the app will catch up */ }
    rearm();
  });
  // Mail read, deleted or moved elsewhere (another tab, a phone): refresh the unread badge.
  let flagTimer = null;
  const onChange = () => {
    clearTimeout(flagTimer);
    flagTimer = setTimeout(async () => { try { await recount(); } catch {} rearm(); }, 300);
  };
  client.on('flags', onChange);
  client.on('expunge', onChange);

  let stage = 'connect';
  try {
    await client.connect();
    stage = 'open';
    await client.mailboxOpen(path, { readOnly: true }); // only watching; never changes flags
    conn.retry = 0;
    await recount();
    rearm();
  } catch (e) {
    // Only a folder that no longer exists ends the watch. Anything else (e.g. a brand-new account
    // the mail server hasn't loaded yet, or a restart) is retried by the 'close' handler.
    const gone = stage === 'open' && (e?.serverResponseCode === 'NONEXISTENT' || /doesn't exist|not exist/i.test(e?.responseText || ''));
    if (gone) { conn.stopped = true; w.counts.delete(path); }
    try { client.close(); } catch {}
  }
}

function reconcile(userId, w) {
  const want = new Set(followedFolders(userId));
  let removed = false;
  for (const [path, conn] of w.folders) {
    if (want.has(path)) continue;
    removed = true;
    conn.stopped = true;
    w.folders.delete(path);
    w.counts.delete(path);
    conn.client?.logout().catch(() => {});
  }
  for (const path of want) {
    if (w.folders.has(path)) continue;
    const conn = { client: null, retry: 0, stopped: false };
    w.folders.set(path, conn);
    connectFolder(userId, w, path, conn).catch(() => {});
  }
  // New folders report their own counts once connected; an early empty count would reset the badge.
  if (removed) pushUnread(userId, w);
}

export function watch(userId) {
  let w = watchers.get(userId);
  if (w) { clearTimeout(w.stopTimer); w.stopTimer = null; return; }
  w = { stopTimer: null, stopped: false, folders: new Map(), counts: new Map() };
  watchers.set(userId, w);
  reconcile(userId, w);
}

function stop(userId, w) {
  w.stopped = true;
  clearTimeout(w.stopTimer);
  watchers.delete(userId);
  for (const conn of w.folders.values()) { conn.stopped = true; conn.client?.logout().catch(() => {}); }
}

export function unwatch(userId, delay = LINGER_MS) {
  const w = watchers.get(userId);
  if (!w || w.stopTimer) return;
  w.stopTimer = setTimeout(() => stop(userId, w), delay);
  w.stopTimer.unref?.();
}

export const watchingCount = () => watchers.size;
/** Open watching connections for one user (for tests and diagnostics). */
export const watchedFolders = (userId) => [...(watchers.get(userId)?.folders.keys() || [])];

export function startMailNotifications() {
  if (!mailEnabled()) return;
  onPresence((userId, online) => (online ? watch(userId) : unwatch(userId)));
}

export function stopAll() {
  for (const [id, w] of watchers) stop(id, w);
}
