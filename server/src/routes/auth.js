import { Router } from 'express';
import { q, tx } from '../db.js';
import { str, bad, HttpError } from '../util.js';
import {
  verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie, tokenFromReq,
  requireAuth, validatePassword, hashPassword, userFromToken,
} from '../auth.js';
import * as guard from '../security/guard.js';
import { createOrg } from '../tenancy.js';
import { setMailPassword } from '../mail/config.js';
import * as twoFactor from '../twofactor.js';
import { otpauthUrl } from '../totp.js';

export default function authRoutes({ secureCookies }) {
  const r = Router();
  const startSession = (req, res, userId) => {
    const token = createSession(userId);
    setSessionCookie(res, token, secureCookies === true || (secureCookies === 'auto' && req.secure));
    return userFromToken(token);
  };

  r.get('/status', (req, res) => {
    const count = q('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ needsSetup: count === 0, user: userFromToken(tokenFromReq(req)) });
  });

  // First run: create the first company, its domain and the platform owner.
  r.post('/setup', (req, res) => {
    const { userId } = tx(() => {
      if (q('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(409, 'Already set up');
      const b = req.body;
      return createOrg({ name: b.org_name, domain: b.domain, adminName: b.name, adminLocal: b.local, adminPassword: b.password, isSuper: true });
    });
    res.json({ user: startSession(req, res, userId) });
  });

  // Sign in with the full email address.
  r.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const verdict = guard.check(req.ip, username);
    if (verdict.action === 'reject') throw new HttpError(429, 'Too many failed sign-ins from your network. Try again later.');
    if (verdict.action === 'delay') await new Promise((r) => setTimeout(r, verdict.seconds * 1000));
    const row = q('SELECT id, password_hash, mail_hash, disabled FROM users WHERE username = ?').get(username);
    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) {
      guard.recordFailure({ ip: req.ip, login: username, fp: guard.passwordFingerprint(password), service: 'web' });
      throw new HttpError(401, 'Wrong email address or password');
    }
    // Accounts created before email existed get their mailbox password on next sign-in.
    if (!row.mail_hash) setMailPassword(row.id, password);
    // Two-step verification: the password was right; now ask for the code (no session yet).
    if (twoFactor.isEnabled(row.id)) return res.json({ twoFactor: true, ticket: twoFactor.newTicket(row.id) });
    res.json({ user: startSession(req, res, row.id) });
  });

  // Second step: a code from the authenticator app, or a recovery code.
  r.post('/login/code', async (req, res) => {
    const verdict = guard.check(req.ip, '');
    if (verdict.action === 'reject') throw new HttpError(429, 'Too many failed sign-ins from your network. Try again later.');
    if (verdict.action === 'delay') await new Promise((r) => setTimeout(r, verdict.seconds * 1000));
    const t = twoFactor.ticketUser(req.body.ticket);
    if (!t) throw new HttpError(401, 'That took too long. Sign in again.');
    const user = q('SELECT id, username, disabled FROM users WHERE id = ?').get(t.userId);
    if (!user || user.disabled) { twoFactor.endTicket(req.body.ticket); throw new HttpError(401, 'Sign in again.'); }
    const how = twoFactor.verifySecondStep(user.id, req.body.code);
    if (!how) {
      // Wrong codes count like wrong passwords (blocking guessing), and a sign-in gets 5 tries.
      guard.recordFailure({ ip: req.ip, login: user.username, fp: guard.passwordFingerprint(`2fa:${req.body.code}`), service: 'web-2fa' });
      if (++t.tries >= 5) { twoFactor.endTicket(req.body.ticket); throw new HttpError(401, 'Too many wrong codes. Sign in again.'); }
      throw new HttpError(401, 'That code is not right. Check the time on your phone, or use a recovery code.');
    }
    twoFactor.endTicket(req.body.ticket);
    const left = how === 'recovery' ? twoFactor.status(user.id).recoveryLeft : undefined;
    res.json({ user: startSession(req, res, user.id), ...(how === 'recovery' && { recoveryLeft: left }) });
  });

  r.post('/logout', (req, res) => {
    const t = tokenFromReq(req);
    if (t) destroySession(t);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  r.patch('/me', requireAuth, (req, res) => {
    const { name, currentPassword, newPassword } = req.body;
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), req.user.id);
    if (newPassword !== undefined) {
      const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(currentPassword || ''), row.password_hash)) throw bad('Current password is wrong');
      validatePassword(newPassword);
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
      setMailPassword(req.user.id, newPassword);
      // Sign out every other session for this user.
      q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req));
    }
    res.json({ user: userFromToken(tokenFromReq(req)) });
  });

  // ---- two-step verification settings (your own account) ----
  const needPassword = (req) => {
    const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.password || ''), row.password_hash)) throw bad('Your password is not right');
  };
  r.get('/2fa', requireAuth, (req, res) => res.json(twoFactor.status(req.user.id)));
  r.post('/2fa/setup', requireAuth, (req, res) => {
    needPassword(req);
    const secret = twoFactor.startSetup(req.user.id);
    res.json({ secret, otpauth: otpauthUrl(secret, req.user.username, req.user.org_name || 'Workspace') });
  });
  r.post('/2fa/confirm', requireAuth, (req, res) => {
    const codes = twoFactor.confirmSetup(req.user.id, req.body.code);
    if (!codes) throw bad('That code is not right. Enter the 6-digit code your app shows now.');
    // Other devices signed in with just the password are signed out.
    q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req));
    res.json({ recoveryCodes: codes, ...twoFactor.status(req.user.id) });
  });
  r.post('/2fa/recovery-codes', requireAuth, (req, res) => {
    needPassword(req);
    const codes = twoFactor.newCodes(req.user.id);
    if (!codes) throw bad('Two-step verification is off');
    res.json({ recoveryCodes: codes, ...twoFactor.status(req.user.id) });
  });
  r.post('/2fa/disable', requireAuth, (req, res) => {
    needPassword(req);
    if (twoFactor.isEnabled(req.user.id) && !twoFactor.verifySecondStep(req.user.id, req.body.code)) {
      throw bad('Enter a current code from your app (or a recovery code) to turn it off');
    }
    twoFactor.disable(req.user.id);
    res.json(twoFactor.status(req.user.id));
  });

  return r;
}
