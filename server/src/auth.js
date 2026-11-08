import crypto from 'node:crypto';
import { q } from './db.js';
import { uid, now, parseCookies, HttpError } from './util.js';
import { dovecotHash } from './mail/crypt.js';
import { scheduleMailConfig } from './mail/config.js';
import { freshMailHome } from './tenancy.js';

// Where Workspace opens for each person: 'drive' (the default) or 'home'.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'start_page')) q('ALTER TABLE users ADD COLUMN start_page TEXT').run();
// A second time zone shown beside the hours in Calendar (e.g. 'Asia/Tokyo'), or null.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'second_tz')) q('ALTER TABLE users ADD COLUMN second_tz TEXT').run();

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

export function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(token, userId, now() + SESSION_DAYS * 864e5, now(), now(), String(userAgent).slice(0, 400), String(ip).slice(0, 64));
  q('UPDATE users SET last_active = ? WHERE id = ?').run(now(), userId);
  return token;
}

/** A session's public handle (the token itself is a secret and never leaves the cookie). */
export const sessionId = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 20);

/** "Chrome on Windows", "Safari on iPhone", ... from a User-Agent header. */
export function describeDevice(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|fetch/i.test(ua) ? 'Program' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function destroySession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.org_id, u.start_page, u.second_tz,
                        o.name AS org_name, o.allow_external, o.allow_links, o.require_2fa, o.accent AS org_accent, o.logo AS org_logo, s.expires_at, s.last_seen,
                        (SELECT enabled FROM two_factor t WHERE t.user_id = u.id) AS tf_enabled
                 FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                 WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < now() || row.disabled) { destroySession(token); return null; }
  // Last activity, for the signed-in devices list (written at most every 5 minutes).
  if (!row.last_seen || now() - row.last_seen > 5 * 60e3) {
    q('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now(), token);
    q('UPDATE users SET last_active = ? WHERE id = ?').run(now(), row.id);
  }
  // Sliding expiry: refresh when less than half the lifetime remains.
  if (row.expires_at - now() < (SESSION_DAYS / 2) * 864e5) {
    q('UPDATE sessions SET expires_at = ? WHERE token = ?').run(now() + SESSION_DAYS * 864e5, token);
  }
  return {
    id: row.id, username: row.username, email: row.username, name: row.name,
    is_admin: !!row.is_admin || !!row.is_super, is_super: !!row.is_super,
    org_id: row.org_id, org_name: row.org_name, allow_external: !!row.allow_external, allow_links: !!row.allow_links,
    org_accent: row.org_accent || null, org_logo: row.org_logo ? `/api/public/brand/logo/${row.org_id}?v=${row.org_logo.slice(0, 8)}` : null,
    // The company requires two-step verification and this person hasn't set it up yet.
    needs_two_factor: !!row.require_2fa && !row.tf_enabled,
    start_page: row.start_page === 'home' ? 'home' : 'drive',
    second_tz: row.second_tz || null,
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
  // Until required two-step verification is set up, only the account's own endpoints work.
  if (user.needs_two_factor && !req.originalUrl.startsWith('/api/auth/')) {
    return next(new HttpError(403, 'Your company requires two-step verification. Set it up to continue.'));
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return next(new HttpError(403, 'Admins only'));
  next();
}


export function requireSuper(req, res, next) {
  if (!req.user?.is_super) return next(new HttpError(403, 'Platform owner only'));
  next();
}

export function newUserRow({ orgId, username, name, password, is_admin, is_super }) {
  const id = uid();
  q(`INSERT INTO users (id, org_id, username, name, email, password_hash, mail_hash, is_admin, is_super, created_at, mail_home)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, username, name, username, hashPassword(password), dovecotHash(password), is_admin ? 1 : 0, is_super ? 1 : 0, now(), freshMailHome(username, id));
  scheduleMailConfig();
  return id;
}
