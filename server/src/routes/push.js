// Notifications on this device (Web Push, push.js): the server's public key, and turning it on or
// off for a device, plus a test notification.
import { Router } from 'express';
import { vapidKeys, subscribe, unsubscribe, devicesOf, pushTo } from '../push.js';
import { bad } from '../util.js';
import crypto from 'node:crypto';
import { describeDevice } from '../auth.js';
import { q } from '../db.js';

// A device in the list: named from its browser, by a short id (not its push address).
const idOf = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);

export default function pushRoutes() {
  const r = Router();
  // ?endpoint=: this device's own, to mark it in the list.
  r.get('/', (req, res) => res.json({ publicKey: vapidKeys().publicKey, devices: devicesOf(req.user.id).map((d) => ({
    id: idOf(d.endpoint), name: describeDevice(d.device || ''), created_at: d.created_at, last_ok_at: d.last_ok_at, this_device: !!req.query.endpoint && req.query.endpoint === d.endpoint,
  })) }));
  // Stop notifications to one of your devices (a phone you no longer have, say).
  r.post('/remove', (req, res) => {
    const d = devicesOf(req.user.id).find((x) => idOf(x.endpoint) === String(req.body?.id || ''));
    if (!d) throw bad('No such device');
    res.json({ removed: q('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, d.endpoint).changes });
  });
  r.post('/subscribe', (req, res) => {
    try { subscribe(req.user.id, req.body, req.get('user-agent'), req.body?.tz); } catch (e) { throw bad(e.message); }
    res.json({ ok: true });
  });
  r.post('/unsubscribe', (req, res) => res.json({ removed: unsubscribe(req.user.id, req.body?.endpoint) }));
  r.post('/test', async (req, res) => res.json({ sent: await pushTo(req.user.id, { title: 'Workspace notifications are on', body: 'You’ll get mentions, invitations, shared files and the like on this device.', link: '/' }, { force: true }) }));
  return r;
}
