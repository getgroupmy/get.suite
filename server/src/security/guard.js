// Sign-in protection shared by web sign-in and the mail server (via Dovecot's auth policy).
//
// - An IP that fails AUTH_MAX_FAILURES distinct sign-ins (different account or password)
//   within AUTH_WINDOW_MIN minutes is blocked for AUTH_BAN_MIN minutes; again within
//   24 hours and it is blocked for 24 hours. Retrying the *same* wrong password (a phone
//   with an old password) counts once, so it doesn't lock out an office.
// - An account attacked from many addresses is slowed down (never locked), so attackers
//   can't lock real users out.
// - This server's own addresses and the allowlist are never blocked. Private network
//   addresses are slowed down but not blocked, so a NAT quirk can't lock everyone out.
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { q } from '../db.js';
import { getSetting, setSetting } from '../mail/config.js';

const env = (k, d) => Number(process.env[k] || d);
export const LIMITS = {
  maxFailures: env('AUTH_MAX_FAILURES', 10),
  windowMs: env('AUTH_WINDOW_MIN', 15) * 60e3,
  banMs: env('AUTH_BAN_MIN', 60) * 60e3,
  repeatBanMs: 24 * 3600e3,
  accountFailures: env('AUTH_ACCOUNT_FAILURES', 20),
  accountDelaySec: 5,
  privateDelaySec: 3,
};

q(`CREATE TABLE IF NOT EXISTS auth_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  login TEXT NOT NULL,
  fp TEXT NOT NULL,
  service TEXT NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures(ip, at)').run();
q('CREATE INDEX IF NOT EXISTS auth_failures_login ON auth_failures(login, at)').run();
q(`CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();

export function normalizeIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}
const family = (ip) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');

// Private/LAN ranges: slowed down after failures but never blocked (AUTH_SOFT_NETS overrides; "" makes them blockable).
const SOFT_DEFAULT = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,127.0.0.0/8,fc00::/7,fe80::/10,::1';
const PRIVATE = new net.BlockList();
for (const e of (process.env.AUTH_SOFT_NETS ?? SOFT_DEFAULT).split(',')) {
  const c = parseCidr(e);
  if (c) PRIVATE.addSubnet(c.ip, c.prefix, family(c.ip));
}

/** Parse "1.2.3.4", "1.2.3.0/24" or IPv6 equivalents. Returns null when invalid. */
export function parseCidr(entry) {
  const [addr, bits] = String(entry).trim().split('/');
  const ip = normalizeIp(addr);
  if (!net.isIP(ip)) return null;
  const max = net.isIPv6(ip) ? 128 : 32;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { ip, prefix, text: prefix === max ? ip : `${ip}/${prefix}` };
}

/** Addresses that are never blocked: loopback (configurable for tests), this server's own interfaces, env + admin allowlist. */
let neverBan = null;
function buildNeverBan() {
  const list = new net.BlockList();
  const fixed = process.env.AUTH_NEVER_BAN ?? '127.0.0.0/8,::1';
  const own = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address);
  for (const e of [...fixed.split(','), ...own, ...(process.env.AUTH_ALLOWLIST || '').split(','), ...getAllowlist()]) {
    const c = parseCidr(e);
    if (c) list.addSubnet(c.ip, c.prefix, family(c.ip));
  }
  return list;
}
export const isNeverBan = (ip) => { neverBan ??= buildNeverBan(); return neverBan.check(ip, family(ip)); };
export const isPrivate = (ip) => PRIVATE.check(ip, family(ip));

export function getAllowlist() {
  return (getSetting('auth_allowlist') || '').split('\n').filter(Boolean);
}
export function setAllowlist(entries) {
  const parsed = entries.map((e) => [e, parseCidr(e)]);
  const bad = parsed.find(([, c]) => !c);
  if (bad) throw Object.assign(new Error(`“${bad[0]}” is not an IP address or range`), { status: 400 });
  const texts = [...new Set(parsed.map(([, c]) => c.text))];
  setSetting('auth_allowlist', texts.join('\n'));
  neverBan = null;
  // Allowlisting an address lifts any block on it.
  for (const t of texts) {
    const c = parseCidr(t);
    const one = new net.BlockList();
    one.addSubnet(c.ip, c.prefix, family(c.ip));
    for (const b of q('SELECT ip FROM ip_bans').all()) if (one.check(b.ip, family(b.ip))) unban(b.ip);
  }
  return texts;
}

/** Short fingerprint of a password, only to tell "same wrong password again" from "new guess". */
export function passwordFingerprint(password) {
  let nonce = getSetting('auth_policy_nonce');
  if (!nonce) { nonce = crypto.randomBytes(16).toString('hex'); setSetting('auth_policy_nonce', nonce); }
  return crypto.createHash('sha256').update(nonce).update(String(password)).digest('hex').slice(0, 4);
}

function activeBan(ip, now = Date.now()) {
  const b = q('SELECT * FROM ip_bans WHERE ip = ?').get(ip);
  return b && b.until > now ? b : null;
}

const distinctSince = (col, value, since) =>
  q(`SELECT COUNT(DISTINCT login || ' ' || fp) AS n FROM auth_failures WHERE ${col} = ? AND at > ?`).get(value, since).n;

/**
 * Decide on a sign-in attempt before checking the password.
 * Returns { action: 'allow' } | { action: 'reject', until } | { action: 'delay', seconds }.
 */
export function check(rawIp, login, now = Date.now()) {
  const ip = normalizeIp(rawIp);
  if (!ip || isNeverBan(ip)) return { action: 'allow' };
  const ban = activeBan(ip, now);
  if (ban) return { action: 'reject', until: ban.until };
  const since = now - LIMITS.windowMs;
  if (login && distinctSince('login', String(login).toLowerCase(), since) >= LIMITS.accountFailures) {
    return { action: 'delay', seconds: LIMITS.accountDelaySec };
  }
  if (isPrivate(ip) && distinctSince('ip', ip, since) >= LIMITS.maxFailures) return { action: 'delay', seconds: LIMITS.privateDelaySec };
  return { action: 'allow' };
}

/** Record a failed sign-in; blocks the IP when it crosses the limit. Returns the new ban, if any. */
export function recordFailure({ ip: rawIp, login, fp, service }, now = Date.now()) {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  q('INSERT INTO auth_failures (at, ip, login, fp, service) VALUES (?, ?, ?, ?, ?)')
    .run(now, ip, String(login || '').toLowerCase().slice(0, 254), String(fp || '').slice(0, 16), String(service || 'unknown').slice(0, 20));
  if (isNeverBan(ip) || isPrivate(ip) || activeBan(ip, now)) return null;
  const failures = distinctSince('ip', ip, now - LIMITS.windowMs);
  if (failures < LIMITS.maxFailures) return null;

  const prev = q('SELECT * FROM ip_bans WHERE ip = ?').get(ip);
  const repeat = prev && now - prev.until < LIMITS.repeatBanMs;
  const strikes = repeat ? prev.strikes + 1 : 1;
  const until = now + (repeat ? LIMITS.repeatBanMs : LIMITS.banMs);
  const reason = `${failures} failed sign-ins in ${Math.round(LIMITS.windowMs / 60e3)} min (${service})`;
  q(`INSERT INTO ip_bans (ip, until, strikes, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET until = excluded.until, strikes = excluded.strikes, reason = excluded.reason, created_at = excluded.created_at`)
    .run(ip, until, strikes, reason, now);
  console.log(`[security] Blocked ${ip} until ${new Date(until).toISOString()}: ${reason}`);
  return { ip, until, strikes, reason };
}

export function unban(ip) {
  const n = normalizeIp(ip);
  q('DELETE FROM ip_bans WHERE ip = ?').run(n);
  q('DELETE FROM auth_failures WHERE ip = ?').run(n); // start fresh
}

export function listBans(now = Date.now()) {
  return q('SELECT ip, until, strikes, reason, created_at FROM ip_bans WHERE until > ? ORDER BY created_at DESC').all(now);
}

export function recentFailures(limit = 100) {
  return q('SELECT at, ip, login, service FROM auth_failures ORDER BY at DESC LIMIT ?').all(limit);
}

/** Summary for the admin screen, including a warning when every failure comes from a private address. */
export function overview(now = Date.now()) {
  const day = q('SELECT ip FROM auth_failures WHERE at > ?').all(now - 24 * 3600e3).map((r) => r.ip);
  const outside = day.filter((ip) => !isPrivate(ip)).length;
  return {
    limits: { maxFailures: LIMITS.maxFailures, windowMin: LIMITS.windowMs / 60e3, banMin: LIMITS.banMs / 60e3, accountFailures: LIMITS.accountFailures },
    failures24h: day.length,
    natWarning: day.length >= 20 && outside === 0,
    bans: listBans(now),
    recent: recentFailures(),
    allowlist: getAllowlist(),
  };
}

/** Housekeeping: drop failure records older than a day and expired bans older than a day. */
export function purge(now = Date.now()) {
  q('DELETE FROM auth_failures WHERE at < ?').run(now - 24 * 3600e3);
  q('DELETE FROM ip_bans WHERE until < ?').run(now - LIMITS.repeatBanMs);
}
