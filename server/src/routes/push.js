// Notifications on this device (Web Push, push.js): the server's public key, and turning it on or
// off for a device, plus a test notification.
import { Router } from 'express';
import { vapidKeys, subscribe, unsubscribe, devicesOf, pushTo } from '../push.js';
import { bad } from '../util.js';

export default function pushRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json({ publicKey: vapidKeys().publicKey, devices: devicesOf(req.user.id).map(({ endpoint, ...d }) => ({ ...d, endpoint })) }));
  r.post('/subscribe', (req, res) => {
    try { subscribe(req.user.id, req.body, req.get('user-agent')); } catch (e) { throw bad(e.message); }
    res.json({ ok: true });
  });
  r.post('/unsubscribe', (req, res) => res.json({ removed: unsubscribe(req.user.id, req.body?.endpoint) }));
  r.post('/test', async (req, res) => res.json({ sent: await pushTo(req.user.id, { title: 'Workspace notifications are on', body: 'You’ll get mentions, invitations, shared files and the like on this device.', link: '/' }, { force: true }) }));
  return r;
}
