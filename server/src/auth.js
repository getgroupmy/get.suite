import './passkeys.js'; // its table, for the two-step check below
import { cleanCalPrefs } from './calprefs.js';
import crypto from 'node:crypto';
import { rulesOf, passwordProblem, isExpired } from './passwordrules.js';
import { q } from './db.js';
import { uid, now, parseCookies, HttpError } from './util.js';
import { dovecotHash } from './mail/crypt.js';
import { scheduleMailConfig } from './mail/config.js';
import { freshMailHome } from './tenancy.js';
import { networkAllowed, NETWORK_REFUSED } from './netrules.js';
import { bearerOf, tokenRow, tokenRefusal } from './apitokens.js';
import { markActive } from './activedays.js';

// Where Workspace opens for each person: 'drive' (the default) or 'home'.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'start_page')) q('ALTER TABLE users ADD COLUMN start_page TEXT').run();
// Set by an admin (new account, or a reset): the person must choose their own password before using Workspace.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'must_change_password')) q('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0').run();
// A second time zone shown beside the hours in Calendar (e.g. 'Asia/Tokyo'), or null.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'second_tz')) q('ALTER TABLE users ADD COLUMN second_tz TEXT').run();
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'cal_prefs')) q('ALTER TABLE users ADD COLUMN cal_prefs TEXT').run(); // JSON: Calendar settings (calprefs.js)
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'ring_off')) q('ALTER TABLE users ADD COLUMN ring_off INTEGER NOT NULL DEFAULT 0').run(); // calls don't pop up (they still reach the bell)
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'keys_off')) q('ALTER TABLE users ADD COLUMN keys_off INTEGER NOT NULL DEFAULT 0').run(); // single-key shortcuts (C, J/K, G then M, ?) turned off
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_tips_off')) q('ALTER TABLE users ADD COLUMN mail_tips_off INTEGER NOT NULL DEFAULT 0').run(); // Compose's notes (Include …?, after hours, away…) turned off
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'search_tips_off')) q('ALTER TABLE users ADD COLUMN search_tips_off INTEGER NOT NULL DEFAULT 0').run(); // the search box's "Type to make things" tips hidden
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_advance')) q('ALTER TABLE users ADD COLUMN mail_advance TEXT').run(); // after archiving or deleting the open message: 'newer', 'older' or null (back to the list)
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_pane')) q('ALTER TABLE users ADD COLUMN mail_pane TEXT').run(); // Mail's reading pane: 'below', 'off', or null (beside the list)
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_list_width')) q('ALTER TABLE users ADD COLUMN mail_list_width INTEGER').run(); // Mail's list beside the reading pane, in pixels (null: the usual)
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_list')) q('ALTER TABLE users ADD COLUMN mail_list TEXT').run(); // Mail's list: JSON { pictures, compact }
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'world_clocks')) q('ALTER TABLE users ADD COLUMN world_clocks TEXT').run(); // JSON [IANA zones] for Calendar's world clock
// The kind of files documents, spreadsheets and presentations download as when there's no choice to make (a .zip, your data): 'office' (Word, Excel, PowerPoint; the default) or 'odf' (OpenDocument).
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'file_format')) q('ALTER TABLE users ADD COLUMN file_format TEXT').run();
// How Drive lists files for this person: JSON { sort: 'name' | 'modified' | 'size', desc, layout: 'list' | 'grid' }.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'drive_view')) q('ALTER TABLE users ADD COLUMN drive_view TEXT').run();
const DRIVE_SORTS = ['name', 'modified', 'size'];
// Home's cards, in their usual order; someone's own order and hidden ones in users.home_layout (JSON).
export const HOME_CARDS = ['events', 'tasks', 'unread', 'approvals', 'out', 'signing', 'apps', 'recent', 'notes', 'dates', 'touch', 'office', 'followups', 'nudges', 'people', 'comments', 'saved', 'reminders', 'notereminders', 'meetings'];
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'home_layout')) q('ALTER TABLE users ADD COLUMN home_layout TEXT').run();
/** Someone's Home: { order: every card once (theirs first, any new ones after), hidden: [cards] }. */
export function homeLayout(v) {
  let o = {};
  try { o = typeof v === 'string' ? JSON.parse(v) : v || {}; } catch { o = {}; }
  const mine = (Array.isArray(o?.order) ? o.order : []).filter((k, i, a) => HOME_CARDS.includes(k) && a.indexOf(k) === i);
  return { order: [...mine, ...HOME_CARDS.filter((k) => !mine.includes(k))], hidden: HOME_CARDS.filter((k) => Array.isArray(o?.hidden) && o.hidden.includes(k)) };
}
/** Someone's Drive view, tidied: { sort, desc, layout } (name, A→Z, list when not chosen). */
export function driveView(v) {
  let o = {};
  try { o = typeof v === 'string' ? JSON.parse(v) : v || {}; } catch { o = {}; }
  return { sort: DRIVE_SORTS.includes(o?.sort) ? o.sort : 'name', desc: !!o?.desc, layout: o?.layout === 'grid' ? 'grid' : 'list' };
}
// Word, Excel, PowerPoint, OpenDocument and Markdown files uploaded in Drive become documents, spreadsheets and presentations (1), or stay files (0, the default).
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'convert_uploads')) q('ALTER TABLE users ADD COLUMN convert_uploads INTEGER NOT NULL DEFAULT 0').run();

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

/** Throws (400) unless the password meets the rules: the company's, when it's for someone in one. */
export function validatePassword(pw, { orgId = null, email = '', name = '' } = {}) {
  const problem = passwordProblem(pw, rulesOf(orgId), { email, name });
  if (problem) throw new HttpError(400, problem);
}

// How each session signed in (Settings → Signed-in devices): password, code (password and an app's code),
// recovery (password and a recovery code), passkey, or password-passkey (a passkey as the second step).
if (!q('PRAGMA table_info(sessions)').all().some((c) => c.name === 'method')) q('ALTER TABLE sessions ADD COLUMN method TEXT').run();
export const SIGN_IN_METHODS = ['password', 'code', 'recovery', 'passkey', 'password-passkey'];

export function createSession(userId, { userAgent = '', ip = '', method = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen, user_agent, ip, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(token, userId, now() + SESSION_DAYS * 864e5, now(), now(), String(userAgent).slice(0, 400), String(ip).slice(0, 64), SIGN_IN_METHODS.includes(method) ? method : null);
  q('UPDATE users SET last_active = ? WHERE id = ?').run(now(), userId);
  markActive(userId);
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

// Sign-in sessions (a company setting): signed out after so many minutes without using Workspace,
// and after so many hours however active (0: neither; sessions otherwise last 30 days, renewed as used).
for (const [col, type] of [['session_idle_min', 'INTEGER NOT NULL DEFAULT 0'], ['session_max_hours', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === col)) q(`ALTER TABLE orgs ADD COLUMN ${col} ${type}`).run();
}
export const IDLE_CHOICES = [0, 15, 30, 60, 120, 240, 480];
export const MAX_HOURS_CHOICES = [0, 8, 12, 24, 72, 168];
/** How long the person has been away from the keyboard and mouse, as the web app reports it (ms), or null. */
export const idleOf = (req) => { const v = Number(req.get?.('x-user-idle')); return Number.isFinite(v) && v >= 0 ? v : null; };

/**
 * The signed-in person for a session, or null. `idleMs`: how long they've been away (from the app);
 * with the company's limits, a session idle too long (by that, or by its last request) or too old ends.
 */
export function userFromToken(token, { idleMs = null } = {}) {
  if (!token) return null;
  const row = q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.org_id, u.start_page, u.second_tz, u.world_clocks, u.mail_advance, u.mail_pane, u.mail_list_width, u.mail_list, u.ring_off, u.keys_off, u.mail_tips_off, u.search_tips_off, u.cal_prefs, u.file_format, u.drive_view, u.home_layout, u.convert_uploads, u.must_change_password, u.recovery_email, COALESCE(u.password_set_at, u.created_at) AS password_set_at, o.pw_max_days,
                        o.name AS org_name, o.allow_external, o.allow_links, o.link_max_days, o.link_password, o.require_2fa, o.accent AS org_accent, o.logo AS org_logo, s.expires_at, s.last_seen, s.created_at AS session_at, o.session_idle_min, o.session_max_hours,
                        (COALESCE((SELECT enabled FROM two_factor t WHERE t.user_id = u.id), 0) OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id)) AS tf_enabled
                 FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id
                 WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (row.expires_at < now() || row.disabled) { destroySession(token); return null; }
  const idleLimit = row.session_idle_min * 60e3;
  if ((row.session_max_hours && row.session_at && now() - row.session_at > row.session_max_hours * 3600e3)
    || (idleLimit && ((idleMs !== null && idleMs > idleLimit) || (row.last_seen && now() - row.last_seen > idleLimit + 5 * 60e3)))) {
    destroySession(token);
    return null;
  }
  // Last activity, for the signed-in devices list (written at most every 5 minutes).
  if (!row.last_seen || now() - row.last_seen > 5 * 60e3) {
    q('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now(), token);
    q('UPDATE users SET last_active = ? WHERE id = ?').run(now(), row.id);
    markActive(row.id);
  }
  // Sliding expiry: refresh when less than half the lifetime remains.
  if (row.expires_at - now() < (SESSION_DAYS / 2) * 864e5) {
    q('UPDATE sessions SET expires_at = ? WHERE token = ?').run(now() + SESSION_DAYS * 864e5, token);
  }
  return userOf(row);
}

const USER_COLUMNS = `u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.org_id, u.start_page, u.second_tz, u.world_clocks, u.mail_advance, u.mail_pane, u.mail_list_width, u.mail_list, u.ring_off, u.keys_off, u.mail_tips_off, u.search_tips_off, u.cal_prefs, u.file_format, u.drive_view, u.home_layout, u.convert_uploads, u.must_change_password, u.recovery_email, COALESCE(u.password_set_at, u.created_at) AS password_set_at, o.pw_max_days,
  o.name AS org_name, o.allow_external, o.allow_links, o.link_max_days, o.link_password, o.require_2fa, o.accent AS org_accent, o.logo AS org_logo, o.session_idle_min, (COALESCE((SELECT enabled FROM two_factor t WHERE t.user_id = u.id), 0) OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id)) AS tf_enabled`;

/** The person an API token acts for (see apitokens.js), as requireAuth gives it, with req.apiToken set. */
function userFromApiToken(req) {
  const t = tokenRow(bearerOf(req), req.ip);
  if (!t) return null;
  const row = q(`SELECT ${USER_COLUMNS} FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? AND u.disabled = 0`).get(t.user_id);
  if (!row) return null;
  req.apiToken = { id: t.id, scope: t.scope };
  return userOf(row);
}

/** A person as requireAuth gives them (their company's settings included), or null when they're disabled or gone. */
export function userById(id) {
  const row = q(`SELECT ${USER_COLUMNS} FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? AND u.disabled = 0`).get(String(id));
  return row ? userOf(row) : null;
}

function userOf(row) {
  return {
    id: row.id, username: row.username, email: row.username, name: row.name,
    is_admin: !!row.is_admin || !!row.is_super, is_super: !!row.is_super,
    org_id: row.org_id, org_name: row.org_name, allow_external: !!row.allow_external, allow_links: !!row.allow_links, link_max_days: row.link_max_days || null, link_password: !!row.link_password,
    org_accent: row.org_accent || null, org_logo: row.org_logo ? `/api/public/brand/logo/${row.org_id}?v=${row.org_logo.slice(0, 8)}` : null,
    // The company requires two-step verification and this person hasn't set it up yet (an authenticator app or a passkey).
    needs_two_factor: !!row.require_2fa && !row.tf_enabled,
    // An admin set their password: they choose their own before anything else.
    // …or their password has expired under the company's rules (they choose a new one first, too).
    must_change_password: !!row.must_change_password || isExpired({ max_days: row.pw_max_days }, row.password_set_at),
    password_expired: !row.must_change_password && isExpired({ max_days: row.pw_max_days }, row.password_set_at),
    start_page: row.start_page === 'home' ? 'home' : 'drive',
    second_tz: row.second_tz || null,
    world_clocks: (() => { try { return JSON.parse(row.world_clocks || '[]'); } catch { return []; } })(),
    mail_advance: row.mail_advance || 'list',
    mail_pane: ['below', 'off'].includes(row.mail_pane) ? row.mail_pane : 'right',
    mail_list_width: row.mail_list_width || null,
    mail_list: (() => { try { const v = JSON.parse(row.mail_list || '{}'); return { pictures: !!v.pictures, compact: !!v.compact }; } catch { return { pictures: false, compact: false }; } })(),
    ring: !row.ring_off, // calls pop up on screen with Join
    keys: !row.keys_off, // single-key keyboard shortcuts (WCAG 2.1.4: they can be turned off)
    mail_tips: !row.mail_tips_off, // notes while writing mail
    search_tips: !row.search_tips_off, // the search box's tips for making things (event …, task …)
    cal_prefs: cleanCalPrefs((() => { try { return JSON.parse(row.cal_prefs || 'null'); } catch { return null; } })()),
    file_format: row.file_format === 'odf' ? 'odf' : 'office',
    drive_view: driveView(row.drive_view),
    home_layout: homeLayout(row.home_layout),
    convert_uploads: !!row.convert_uploads,
    recovery_email: row.recovery_email || null, // a personal address for "Forgot password?"
    session_idle_min: row.session_idle_min || 0,
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
  const cookie = tokenFromReq(req);
  // A script with an API token (and no session cookie): the same API, as that person, within the token's limits.
  const user = cookie ? userFromToken(cookie, { idleMs: idleOf(req) }) : bearerOf(req) ? userFromApiToken(req) : null;
  if (!user) return next(new HttpError(401, bearerOf(req) && !cookie ? 'This API token isn’t valid (expired, revoked, or not allowed by your company)' : 'Not signed in'));
  if (req.apiToken) { const why = tokenRefusal(req.apiToken, req); if (why) return next(new HttpError(403, why)); }
  if (!networkAllowed(user, req.ip)) return next(new HttpError(403, NETWORK_REFUSED));
  // Until required two-step verification is set up, only the account's own endpoints work.
  if (user.needs_two_factor && !req.originalUrl.startsWith('/api/auth/')) {
    return next(new HttpError(403, 'Your company requires two-step verification. Set it up to continue.'));
  }
  // Likewise until they've chosen their own password (when an admin asked them to).
  if (user.must_change_password && !req.originalUrl.startsWith('/api/auth/')) {
    return next(new HttpError(403, 'Choose your own password to continue.'));
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
  q('UPDATE users SET password_set_at = ? WHERE id = ?').run(now(), id);
  scheduleMailConfig();
  return id;
}
