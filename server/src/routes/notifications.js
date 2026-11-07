// The bell: GET the latest notifications and how many are unread; mark some (or all) read.
import { Router } from 'express';
import { bad } from '../util.js';
import { listFor, markRead } from '../notifications.js';

export default function notificationRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(listFor(req.user.id)));
  r.post('/read', (req, res) => {
    const ids = req.body?.all ? 'all' : Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : null;
    if (!ids) throw bad('Say which, or all');
    markRead(req.user.id, ids);
    res.json(listFor(req.user.id));
  });
  return r;
}
