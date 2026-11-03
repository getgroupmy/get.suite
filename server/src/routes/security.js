import { Router } from 'express';
import { bad } from '../util.js';
import { requireSuper } from '../auth.js';
import { overview, unban, setAllowlist, normalizeIp } from '../security/guard.js';
import net from 'node:net';

// Platform owner only: blocked addresses, recent failed sign-ins, allowlist.
export default function securityRoutes() {
  const r = Router();
  r.use(requireSuper);

  r.get('/', (req, res) => res.json(overview()));

  r.delete('/bans/:ip', (req, res) => {
    const ip = normalizeIp(req.params.ip);
    if (!net.isIP(ip)) throw bad('Not an IP address');
    unban(ip);
    res.json({ ok: true });
  });

  r.put('/allowlist', (req, res) => {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : String(req.body.entries || '').split(/[\s,]+/);
    try { res.json({ allowlist: setAllowlist(entries.map(String).filter(Boolean).slice(0, 200)) }); }
    catch (e) { throw bad(e.message); }
  });

  return r;
}
