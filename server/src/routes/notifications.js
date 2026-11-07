// The bell: GET the latest notifications and how many are unread; mark some (or all) read.
import { Router } from 'express';
import { bad } from '../util.js';
import { listFor, markRead, KINDS, offFor, setOff } from '../notifications.js';

export default function notificationRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(listFor(req.user.id)));
  // Which kinds you get: { kinds: [{ kind, label, on }] }; PUT { off: [kinds] }.
  const settings = (userId) => { const off = offFor(userId); return { kinds: KINDS.map(([kind, label]) => ({ kind, label, on: !off.includes(kind) })) }; };
  r.get('/settings', (req, res) => res.json(settings(req.user.id)));
  r.put('/settings', (req, res) => {
    if (!Array.isArray(req.body?.off)) throw bad('Say which kinds to turn off');
    setOff(req.user.id, req.body.off);
    res.json(settings(req.user.id));
  });
  r.post('/read', (req, res) => {
    const ids = req.body?.all ? 'all' : Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : null;
    if (!ids) throw bad('Say which, or all');
    markRead(req.user.id, ids);
    res.json(listFor(req.user.id));
  });
  return r;
}
