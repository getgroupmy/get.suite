import { Router } from 'express';
import { rulesOf, rulesText } from '../passwordrules.js';
import { networkAllowed, NETWORK_REFUSED } from '../netrules.js';
import { q, tx } from '../db.js';
import { str, bad, HttpError } from '../util.js';
import {
  verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie, tokenFromReq,
  requireAuth, validatePassword, hashPassword, userFromToken, idleOf, sessionId, describeDevice,
} from '../auth.js';
import * as guard from '../security/guard.js';
import { createOrg } from '../tenancy.js';
import { setMailPassword, setMailAppPassword, mailEnabled, MAIL_HOSTNAME } from '../mail/config.js';
import crypto from 'node:crypto';
import * as twoFactor from '../twofactor.js';
import { verifyRegistration, verifyAssertion, b64url, ALLOWED_ALGS } from '../webauthn.js';
import { newChallenge, takeChallenge, passkeysOf, passkeyById, MAX_PASSKEYS } from '../passkeys.js';
import { otpauthUrl } from '../totp.js';
import { audit } from '../audit.js';
import { newDeviceSignIn } from '../alerts.js';
import { smtpFor } from '../mail/imap.js';

// "Forgot password?": a link (valid for an hour, once) sent to the personal recovery address someone
// added in Settings. The reply never says whether the account exists or has an address.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'recovery_email')) q('ALTER TABLE users ADD COLUMN recovery_email TEXT').run();
q(`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
)`).run();
const RESET_MINUTES = 60;
const resetHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const EMAIL_RE = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;
const resetAsks = new Map(); // "user:<id>" / "ip:<ip>" -> times asked in the last hour
function tooMany(key, max) {
  const t = Date.now();
  const list = (resetAsks.get(key) || []).filter((x) => x > t - 36e5);
  resetAsks.set(key, [...list, t]);
  return list.length >= max;
}
/** How the link is sent (replaceable in tests): from the person's own address, to their recovery address. */
let resetMailer = async (user, to, link) => {
  await smtpFor(user).sendMail({
    from: { name: 'Workspace', address: user.username }, to, subject: 'Reset your Workspace password',
    text: [`Someone (hopefully you) asked to reset the password for ${user.username}.`, '', `Choose a new password here (the link works once, for ${RESET_MINUTES} minutes):`, link, '',
      'If it wasn’t you, ignore this email: your password stays as it is.'].join('\n'),
  });
};
export const setResetMailer = (fn) => { resetMailer = fn; };

export default function authRoutes({ secureCookies }) {
  const r = Router();
  const startSession = (req, res, userId) => {
    const token = createSession(userId, { userAgent: req.headers['user-agent'] || '', ip: req.ip });
    newDeviceSignIn(userId, describeDevice(req.headers['user-agent'] || ''), req.ip);
    setSessionCookie(res, token, secureCookies === true || (secureCookies === 'auto' && req.secure));
    return userFromToken(token);
  };

  // This site, as passkeys see it: its address and host name.
  const site = (req) => {
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return { origin, rpId: new URL(origin).hostname };
  };

  r.get('/status', (req, res) => {
    const count = q('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ needsSetup: count === 0, can_reset: mailEnabled(), user: userFromToken(tokenFromReq(req), { idleMs: idleOf(req) }) });
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
      if (row) audit(req, 'sign-in.failed', { actor: null, org: q('SELECT org_id FROM users WHERE id = ?').get(row.id)?.org_id ?? null, target: username, details: { reason: row.disabled ? 'disabled' : 'password' } });
      throw new HttpError(401, 'Wrong email address or password');
    }
    // Only from the company's own networks, when it says so (the password was right: not a failed guess).
    { const u = q('SELECT id, org_id, is_super FROM users WHERE id = ?').get(row.id); if (!networkAllowed(u, req.ip)) throw new HttpError(403, NETWORK_REFUSED); }
    // Accounts created before email existed get their mailbox password on next sign-in.
    if (!row.mail_hash) setMailPassword(row.id, password);
    // Two-step verification: the password was right; now ask for the code (no session yet).
    if (twoFactor.isEnabled(row.id)) return res.json({ twoFactor: true, ticket: twoFactor.newTicket(row.id) });
    // No app, but passkeys, and the company requires two steps: the passkey is the second step.
    if (q('SELECT o.require_2fa FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ?').get(row.id)?.require_2fa && passkeysOf(row.id).length) {
      const ticket = b64url(crypto.randomBytes(18));
      const challenge = newChallenge(`login:${ticket}`, row.id);
      return res.json({ passkeyStep: true, ticket, options: { challenge, rpId: site(req).rpId, userVerification: 'required', timeout: 120000, allowCredentials: passkeysOf(row.id).map((p) => ({ type: 'public-key', id: p.id })) } });
    }
    const u = startSession(req, res, row.id);
    audit(req, 'sign-in', { actor: u, target: u.username });
    res.json({ user: u });
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
      audit(req, 'sign-in.failed', { actor: null, org: q('SELECT org_id FROM users WHERE id = ?').get(user.id)?.org_id ?? null, target: user.username, details: { reason: 'code' } });
      if (++t.tries >= 5) { twoFactor.endTicket(req.body.ticket); throw new HttpError(401, 'Too many wrong codes. Sign in again.'); }
      throw new HttpError(401, 'That code is not right. Check the time on your phone, or use a recovery code.');
    }
    twoFactor.endTicket(req.body.ticket);
    const left = how === 'recovery' ? twoFactor.status(user.id).recoveryLeft : undefined;
    const u = startSession(req, res, user.id);
    audit(req, 'sign-in', { actor: u, target: u.username, details: { twoStep: how } });
    res.json({ user: u, ...(how === 'recovery' && { recoveryLeft: left }) });
  });

  r.post('/logout', (req, res) => {
    const t = tokenFromReq(req);
    const u = t && userFromToken(t);
    if (u) audit(req, 'sign-out', { actor: u, target: u.username });
    if (t) destroySession(t);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  // Your recovery address (or null to remove it); your password is asked for, as it's a way into the account.
  r.put('/recovery-email', requireAuth, (req, res) => {
    const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.password || ''), row.password_hash)) throw bad('Your password is not right');
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw bad('Enter an email address');
    if (email && email === req.user.username) throw bad('Use a personal address, not this account’s own: you couldn’t read it without signing in');
    q('UPDATE users SET recovery_email = ? WHERE id = ?').run(email, req.user.id);
    audit(req, email ? 'recovery.set' : 'recovery.remove', { target: req.user.username });
    res.json({ recovery_email: email });
  });
  // Ask for a reset link. Always the same answer, whether or not anything is sent.
  r.post('/forgot', async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const answer = { ok: true, message: 'If that account has a recovery address, a link to choose a new password is on its way to it.' };
    if (!username || tooMany(`ip:${req.ip}`, 10)) return res.json(answer);
    const user = q('SELECT id, username, name, org_id, recovery_email, disabled, is_super FROM users WHERE username = ?').get(username);
    if (!user || user.disabled || !user.recovery_email || tooMany(`user:${user.id}`, 3) || !networkAllowed(user, req.ip)) return res.json(answer);
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    q('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(resetHash(token), user.id, t, t + RESET_MINUTES * 6e4);
    const base = process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    try { await resetMailer(user, user.recovery_email, `${base}/reset/${token}`); } catch (e) { console.error('[auth] reset email:', e.message); }
    audit(req, 'password.reset_requested', { target: user.username, actor: user });
    res.json(answer);
  });
  // Is a reset link still good? (for the page, before typing a password)
  r.get('/reset/:token', (req, res) => {
    const row = q('SELECT r.*, u.username FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').get(resetHash(req.params.token));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(410, 'This link has expired or been used. Ask for a new one from the sign-in page.');
    res.json({ username: row.username });
  });
  r.post('/reset/:token', (req, res) => {
    const row = q('SELECT * FROM password_resets WHERE token_hash = ?').get(resetHash(req.params.token));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(410, 'This link has expired or been used. Ask for a new one from the sign-in page.');
    const user = q('SELECT id, username, name, org_id, disabled FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.disabled) throw new HttpError(410, 'This account is turned off');
    const pw = String(req.body?.password || '');
    validatePassword(pw, { orgId: user.org_id, email: user.username, name: user.name });
    tx(() => {
      q('UPDATE users SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?').run(hashPassword(pw), Date.now(), user.id);
      q('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), user.id); // every other link stops working too
      q('DELETE FROM sessions WHERE user_id = ?').run(user.id); // signed out everywhere
    });
    setMailPassword(user.id, pw);
    q('UPDATE users SET mail_app_hash = NULL, mail_app_created = NULL WHERE id = ?').run(user.id); // as with an admin's reset
    audit(req, 'password.reset', { target: user.username, actor: user });
    res.json({ ok: true, username: user.username });
  });
  // The company's password rules, to show where a new password is chosen.
  r.get('/password-rules', requireAuth, (req, res) => { const rules = rulesOf(req.user.org_id); res.json({ ...rules, text: rulesText(rules) }); });

  r.patch('/me', requireAuth, (req, res) => {
    const { name, currentPassword, newPassword } = req.body;
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), req.user.id);
    if (newPassword !== undefined) {
      const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(currentPassword || ''), row.password_hash)) throw bad('Current password is wrong');
      validatePassword(newPassword, { orgId: req.user.org_id, email: req.user.username, name: req.user.name });
      if (req.user.must_change_password && verifyPassword(newPassword, row.password_hash)) throw bad('Choose a new password, not the one you were given');
      q('UPDATE users SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?').run(hashPassword(newPassword), Date.now(), req.user.id);
      setMailPassword(req.user.id, newPassword);
      // Sign out every other session for this user.
      q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req));
      audit(req, 'password.change', { target: req.user.username });
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
    audit(req, '2fa.on', { target: req.user.username });
    res.json({ recoveryCodes: codes, ...twoFactor.status(req.user.id) });
  });
  r.post('/2fa/recovery-codes', requireAuth, (req, res) => {
    needPassword(req);
    const codes = twoFactor.newCodes(req.user.id);
    if (!codes) throw bad('Two-step verification is off');
    res.json({ recoveryCodes: codes, ...twoFactor.status(req.user.id) });
  });
  r.post('/2fa/disable', requireAuth, (req, res) => {
    if (q('SELECT require_2fa FROM orgs WHERE id = ?').get(req.user.org_id)?.require_2fa && !passkeysOf(req.user.id).length) throw bad('Your company requires two-step verification, so it can\'t be turned off (add a passkey first, and it can)');
    needPassword(req);
    if (twoFactor.isEnabled(req.user.id) && !twoFactor.verifySecondStep(req.user.id, req.body.code)) {
      throw bad('Enter a current code from your app (or a recovery code) to turn it off');
    }
    twoFactor.disable(req.user.id);
    audit(req, '2fa.off', { target: req.user.username });
    res.json(twoFactor.status(req.user.id));
  });

  // ---- passkeys: sign in with a fingerprint, face, PIN or security key instead of a password ----
  r.get('/passkeys', requireAuth, (req, res) => res.json(passkeysOf(req.user.id)));
  // Making one: your password first, then the browser makes the key and we keep its public half.
  r.post('/passkeys/options', requireAuth, (req, res) => {
    needPassword(req);
    if (passkeysOf(req.user.id).length >= MAX_PASSKEYS) throw bad(`At most ${MAX_PASSKEYS} passkeys`);
    const { rpId } = site(req);
    res.json({
      challenge: newChallenge(`reg:${req.user.id}`, req.user.id),
      rp: { name: req.user.org_name || 'Workspace', id: rpId },
      user: { id: b64url(Buffer.from(req.user.id)), name: req.user.username, displayName: req.user.name || req.user.username },
      pubKeyCredParams: ALLOWED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: passkeysOf(req.user.id).map((p) => ({ type: 'public-key', id: p.id })),
      attestation: 'none', timeout: 120000,
    });
  });
  r.post('/passkeys', requireAuth, (req, res) => {
    const w = takeChallenge(`reg:${req.user.id}`);
    if (!w) throw bad('That took too long. Try adding the passkey again.');
    let made;
    try { made = verifyRegistration(req.body?.credential?.response || {}, { challenge: w.challenge, ...site(req) }); } catch (e) { throw bad(e.message); }
    if (passkeyById(made.id)) throw bad('That passkey is already added');
    const name = str(req.body?.name || 'Passkey', { name: 'Name', max: 60 }) || 'Passkey';
    q('INSERT INTO passkeys (id, user_id, name, public_key, alg, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(made.id, req.user.id, name, made.publicKey, made.alg, made.signCount, Date.now());
    audit(req, 'passkey.added', { target: req.user.username, details: { name } });
    res.status(201).json(passkeysOf(req.user.id));
  });
  r.delete('/passkeys/:id', requireAuth, (req, res) => {
    const p = passkeyById(req.params.id);
    if (!p || p.user_id !== req.user.id) throw new HttpError(404, 'Passkey not found');
    q('DELETE FROM passkeys WHERE id = ?').run(p.id);
    audit(req, 'passkey.removed', { target: req.user.username, details: { name: p.name } });
    res.json(passkeysOf(req.user.id));
  });
  // Signing in with one: the browser offers the passkeys it has for this site (no name typed first).
  r.post('/login/passkey/options', (req, res) => {
    const ticket = b64url(crypto.randomBytes(18));
    res.json({ ticket, options: { challenge: newChallenge(`login:${ticket}`), rpId: site(req).rpId, userVerification: 'required', timeout: 120000, allowCredentials: [] } });
  });
  r.post('/login/passkey', async (req, res) => {
    const verdict = guard.check(req.ip, '');
    if (verdict.action === 'reject') throw new HttpError(429, 'Too many failed sign-ins from your network. Try again later.');
    if (verdict.action === 'delay') await new Promise((r2) => setTimeout(r2, verdict.seconds * 1000));
    const w = takeChallenge(`login:${String(req.body?.ticket || '')}`);
    if (!w) throw new HttpError(401, 'That took too long. Try again.');
    const cred = req.body?.credential || {};
    const p = passkeyById(cred.id);
    const user = p && q('SELECT id, username, disabled, org_id, is_super FROM users WHERE id = ?').get(p.user_id);
    const fail = (why, msg) => {
      guard.recordFailure({ ip: req.ip, login: user?.username || '', fp: guard.passwordFingerprint(`passkey:${cred.id || ''}`), service: 'web-passkey' });
      if (user) audit(req, 'sign-in.failed', { actor: null, org: user.org_id ?? null, target: user.username, details: { reason: why } });
      throw new HttpError(401, msg);
    };
    if (!p || !user) fail('passkey', 'That passkey isn’t on any account here. Sign in with your password, then add it in Settings.');
    if (w.userId && w.userId !== user.id) fail('passkey', 'That passkey is for another account');
    if (user.disabled) fail('disabled', 'That account is suspended');
    let ok;
    try { ok = verifyAssertion(cred.response || {}, { publicKey: p.public_key, alg: p.alg, signCount: p.sign_count }, { challenge: w.challenge, ...site(req) }); } catch (e) { fail('passkey', e.message); }
    // The passkey belongs to this person (when the browser says whose it is, it must agree).
    if (cred.response?.userHandle && cred.response.userHandle !== b64url(Buffer.from(user.id))) fail('passkey', 'That passkey doesn’t match its account');
    if (!networkAllowed(user, req.ip)) throw new HttpError(403, NETWORK_REFUSED);
    q('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(ok.signCount, Date.now(), p.id);
    // A passkey is two steps in one (the device, and your fingerprint, face or PIN): no code after it.
    const u = startSession(req, res, user.id);
    audit(req, 'sign-in', { actor: u, target: u.username, details: { how: 'passkey' } });
    res.json({ user: u });
  });

  // ---- signed-in devices (web sessions) ----
  r.get('/sessions', requireAuth, (req, res) => {
    const mine = tokenFromReq(req);
    const rows = q('SELECT token, created_at, last_seen, user_agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC').all(req.user.id, Date.now());
    res.json(rows.map((s) => ({
      id: sessionId(s.token), current: s.token === mine, device: describeDevice(s.user_agent || ''),
      ip: s.ip || null, created_at: s.created_at, last_seen: s.last_seen,
    })));
  });
  // Sign out one device (your own sessions only), or every device except this one.
  r.delete('/sessions/:id', requireAuth, (req, res) => {
    const rows = q('SELECT token FROM sessions WHERE user_id = ?').all(req.user.id);
    const hit = rows.find((s) => sessionId(s.token) === req.params.id);
    if (!hit) throw new HttpError(404, 'That device is already signed out');
    destroySession(hit.token);
    audit(req, 'session.revoke', { target: req.user.username });
    if (hit.token === tokenFromReq(req)) clearSessionCookie(res);
    res.json({ ok: true });
  });
  r.post('/sessions/sign-out-others', requireAuth, (req, res) => {
    const n = q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req)).changes;
    if (n) audit(req, 'session.revoke', { target: req.user.username, details: { devices: n } });
    res.json({ signedOut: n });
  });

  // ---- mail-app password (phones, Outlook): replaces the account password for IMAP/SMTP ----
  const mailApp = (userId) => {
    const row = q('SELECT mail_app_created FROM users WHERE id = ?').get(userId);
    return { enabled: mailEnabled(), hostname: MAIL_HOSTNAME, twoFactor: twoFactor.isEnabled(userId), appPassword: row?.mail_app_created ? { created: row.mail_app_created } : null };
  };
  r.get('/mail-app', requireAuth, (req, res) => res.json(mailApp(req.user.id)));
  r.post('/mail-app', requireAuth, (req, res) => {
    // Also for calendar and contacts sync (CalDAV/CardDAV), so it works with email turned off too.
    needPassword(req);
    // 16 letters in 4 groups: easy to type on a phone, ~75 bits of randomness.
    const letters = 'abcdefghijkmnopqrstuvwxyz';
    const pw = Array.from(crypto.randomBytes(16), (b) => letters[b % letters.length]).join('').match(/.{4}/g).join('-');
    setMailAppPassword(req.user.id, pw); // exactly as shown, dashes included
    audit(req, 'mail-app.create', { target: req.user.username });
    res.json({ password: pw, ...mailApp(req.user.id) });
  });
  r.delete('/mail-app', requireAuth, (req, res) => {
    needPassword(req);
    setMailAppPassword(req.user.id, null);
    audit(req, 'mail-app.remove', { target: req.user.username });
    res.json(mailApp(req.user.id));
  });

  return r;
}
