// Notifications on phones and computers, even with Workspace closed (Web Push): what lands in the
// bell is also sent to each device someone turned it on for (Settings → Notifications on this
// device), unless they paused notifications or it's their quiet hours. Delivered through the
// browser maker's push service (Apple, Google, Mozilla), encrypted end to end: the service can't
// read it. A device that's gone (unsubscribed, app removed) is forgotten on the next send.
import webpush from 'web-push';
import { q } from './db.js';
import { quietUntil } from './workhours.js';

q(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,             -- the push service's address for this device
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  device TEXT,                           -- what the browser called itself, to tell devices apart
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
)`).run();

/** The server's own key pair (VAPID), made once and kept. */
export function vapidKeys() {
  const row = q("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  q("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return JSON.parse(q("SELECT value FROM settings WHERE key = 'vapid'").get().value);
}

// Only the browser makers' push services: the server posts to this address, so nothing else is taken
// (it could point at something on the local network). PUSH_ANY_ENDPOINT=1 is for tests only.
const SERVICES = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com', 'push.apple.com'];
function allowedEndpoint(endpoint) {
  if (process.env.PUSH_ANY_ENDPOINT === '1') return /^https?:\/\//.test(endpoint);
  let u; try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.port && SERVICES.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}
/** Remember a device: { endpoint, keys: { p256dh, auth } } from the browser's PushManager. */
export function subscribe(userId, sub, device = null) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
  if (!allowedEndpoint(endpoint) || endpoint.length > 1000) throw new Error('Not a push address');
  if (!/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{10,100}$/.test(auth)) throw new Error('Not a push subscription');
  q(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`)
    .run(endpoint, userId, p256dh, auth, device ? String(device).slice(0, 200) : null, Date.now());
}
export const unsubscribe = (userId, endpoint) => q('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || '')).changes;
export const devicesOf = (userId) => q('SELECT endpoint, device, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId);

/**
 * Send { title, body, link } to every device of someone's (not while paused or in quiet hours, unless
 * `force`). Returns how many devices took it.
 */
export async function pushTo(userId, msg, { now = Date.now(), force = false, base = process.env.PUBLIC_URL || 'https://workspace.invalid' } = {}) {
  const subs = q('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return 0;
  if (!force) {
    const u = q('SELECT paused_until FROM users WHERE id = ?').get(userId);
    if ((u?.paused_until && u.paused_until > now) || quietUntil(userId, now)) return 0;
  }
  const keys = vapidKeys();
  // With the number of unread notifications, for the app's icon (the app adds unread mail when it opens).
  const badge = q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId)?.n ?? 0;
  const payload = JSON.stringify({ title: String(msg.title || 'Workspace').slice(0, 200), body: msg.body ? String(msg.body).slice(0, 300) : '', link: msg.link || '/', tag: msg.tag || undefined, badge });
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: 6 * 3600, vapidDetails: { subject: base.startsWith('https:') ? base : 'mailto:postmaster@workspace.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey } });
      q('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?').run(now, s.endpoint);
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) q('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint); // gone for good
      else console.error('[push]', e.statusCode || '', e.message);
    }
  }));
  return ok;
}
