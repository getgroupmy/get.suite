import { Router } from 'express';
import { q } from '../db.js';
import { str, bad, HttpError } from '../util.js';
import {
  verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie, tokenFromReq,
  requireAuth, loginRateLimit, clearLoginAttempts, validatePassword, hashPassword, newUserRow, userFromToken,
} from '../auth.js';

const USERNAME_RE = /^[a-z0-9._-]{2,40}$/i;
export function validUsername(u) {
  const v = str(u, { required: true, name: 'Username', max: 40 });
  if (!USERNAME_RE.test(v)) throw bad('Username may contain letters, numbers, dots, dashes and underscores (2-40 chars)');
  return v.toLowerCase();
}

export default function authRoutes({ secureCookies }) {
  const r = Router();

  r.get('/status', (req, res) => {
    const count = q('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ needsSetup: count === 0, user: userFromToken(tokenFromReq(req)) });
  });

  // First run: create the initial admin account.
  r.post('/setup', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(409, 'Already set up');
    const username = validUsername(req.body.username);
    const name = str(req.body.name, { required: true, name: 'Name', max: 100 });
    validatePassword(req.body.password);
    const id = newUserRow({ username, name, email: str(req.body.email, { max: 200 }), password: req.body.password, is_admin: true });
    const token = createSession(id);
    setSessionCookie(res, token, secureCookies === true || (secureCookies === 'auto' && req.secure));
    res.json({ user: userFromToken(token) });
  });

  r.post('/login', loginRateLimit, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const row = q('SELECT id, password_hash, disabled FROM users WHERE username = ?').get(username);
    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) throw new HttpError(401, 'Wrong username or password');
    clearLoginAttempts(req.ip);
    const token = createSession(row.id);
    setSessionCookie(res, token, secureCookies === true || (secureCookies === 'auto' && req.secure));
    res.json({ user: userFromToken(token) });
  });

  r.post('/logout', (req, res) => {
    const t = tokenFromReq(req);
    if (t) destroySession(t);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  r.patch('/me', requireAuth, (req, res) => {
    const { name, email, currentPassword, newPassword } = req.body;
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), req.user.id);
    if (email !== undefined) q('UPDATE users SET email = ? WHERE id = ?').run(str(email, { max: 200 }), req.user.id);
    if (newPassword !== undefined) {
      const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(currentPassword || ''), row.password_hash)) throw bad('Current password is wrong');
      validatePassword(newPassword);
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
      // Sign out every other session for this user.
      q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req));
    }
    res.json({ user: userFromToken(tokenFromReq(req)) });
  });

  return r;
}
