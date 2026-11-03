import crypto from 'node:crypto';
import { q } from './db.js';
import { uid, now, parseCookies, HttpError } from './util.js';

const SESSION_DAYS = 30;
export const COOKIE = 'nw_sid';
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return ['scrypt', salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, now() + SESSION_DAYS * 864e5);
  return token;
}

export function destroySession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.org_id,
                        o.name AS org_name, o.allow_external, s.expires_at
                 FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                 WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < now() || row.disabled) { destroySession(token); return null; }
  // Sliding expiry: refresh when less than half the lifetime remains.
  if (row.expires_at - now() < (SESSION_DAYS / 2) * 864e5) {
    q('UPDATE sessions SET expires_at = ? WHERE token = ?').run(now() + SESSION_DAYS * 864e5, token);
  }
  return {
    id: row.id, username: row.username, email: row.username, name: row.name,
    is_admin: !!row.is_admin || !!row.is_super, is_super: !!row.is_super,
    org_id: row.org_id, org_name: row.org_name, allow_external: !!row.allow_external,
  };
}

export function tokenFromReq(req) {
  return parseCookies(req.headers.cookie)[COOKIE];
}

export function setSessionCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function requireAuth(req, res, next) {
  const user = userFromToken(tokenFromReq(req));
  if (!user) return next(new HttpError(401, 'Not signed in'));
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return next(new HttpError(403, 'Admins only'));
  next();
}

/** Simple in-memory limiter for login attempts, keyed by IP. */
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const t = now();
  const a = attempts.get(key);
  if (!a || a.reset < t) attempts.set(key, { count: 1, reset: t + 15 * 60e3 });
  else if (++a.count > 10) return next(new HttpError(429, 'Too many login attempts. Try again in 15 minutes.'));
  next();
}
export function clearLoginAttempts(ip) { attempts.delete(ip); }

export function requireSuper(req, res, next) {
  if (!req.user?.is_super) return next(new HttpError(403, 'Platform owner only'));
  next();
}

export function newUserRow({ orgId, username, name, password, is_admin, is_super }) {
  const id = uid();
  q(`INSERT INTO users (id, org_id, username, name, email, password_hash, is_admin, is_super, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, username, name, username, hashPassword(password), is_admin ? 1 : 0, is_super ? 1 : 0, now());
  return id;
}
