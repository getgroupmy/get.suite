// Dovecot auth-policy endpoint. Dovecot asks before every IMAP/SMTP sign-in
// (?command=allow) and reports the outcome afterwards (?command=report).
// Reply {status: -1} rejects, {status: N>0} delays N seconds, {status: 0} allows.
// Runs on its own internal port (not published to the internet) and requires a shared key.
import http from 'node:http';
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../mail/config.js';
import { check, recordFailure } from './guard.js';
import { handleMailNew } from '../mail/mailpush.js';

export const POLICY_PORT = Number(process.env.AUTH_POLICY_PORT || 8081);

export function policySecret() {
  let s = getSetting('auth_policy_secret');
  if (!s) { s = crypto.randomBytes(24).toString('base64url'); setSetting('auth_policy_secret', s); }
  return s;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function handlePolicy(command, body) {
  const ip = body.remote;
  const login = body.login || '';
  if (command === 'allow') {
    const v = check(ip, login);
    if (v.action === 'reject') return { status: -1, msg: 'Too many failed sign-ins from your network. Try again later.' };
    if (v.action === 'delay') return { status: v.seconds, msg: '' };
    return { status: 0, msg: '' };
  }
  if (command === 'report' && body.success === false && !body.policy_reject) {
    recordFailure({ ip, login, fp: body.pwhash, service: body.protocol || 'mail' });
  }
  return { status: 0, msg: '' };
}

export function startPolicyServer(port = POLICY_PORT) {
  const secret = policySecret();
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || !safeEqual(req.headers['x-policy-key'], secret)) return reply(403, { status: 0, msg: '' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
    req.on('end', () => {
      // New mail, told by the mail server as it's delivered (mailpush.js): answered at once.
      if (new URL(req.url, 'http://x').pathname === '/mail-new') {
        let body = null; try { body = JSON.parse(raw || '{}'); } catch { /* ignored */ }
        reply(204, {});
        if (body) handleMailNew(body).catch((e) => console.error('[push] new mail:', e.message));
        return;
      }
      try {
        const command = new URL(req.url, 'http://x').searchParams.get('command');
        reply(200, handlePolicy(command, JSON.parse(raw || '{}')));
      } catch (e) {
        console.error('[security] policy request failed:', e.message);
        reply(200, { status: 0, msg: '' }); // never lock mail out because of our own error
      }
    });
  });
  server.listen(port, () => console.log(`Sign-in policy service on :${port}`));
  return server;
}
