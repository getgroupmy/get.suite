// Generates the mail server's tables from the database and writes them to
// MAIL_CONFIG_DIR, which the mail container watches (see mail/entrypoint.sh).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../db.js';
import { dovecotHash } from './crypt.js';
import { userSieve } from './sieve.js';

export const MAIL_CONFIG_DIR = process.env.MAIL_CONFIG_DIR || null;
export const MAIL_HOSTNAME = process.env.MAIL_HOSTNAME || null;
export const mailEnabled = () => !!MAIL_CONFIG_DIR;
export const DKIM_SELECTOR = 'mail';

// ---------- settings ----------
export function getSetting(key) { return q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; }
export function setSetting(key, value) { q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

/** Secret the app uses to open any mailbox as "user*webmail" (Dovecot master user). */
export function webmailSecret() {
  let s = getSetting('webmail_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    setSetting('webmail_secret', s);
    setSetting('webmail_secret_hash', dovecotHash(s, 5000));
  }
  return s;
}

// ---------- DKIM ----------
export function ensureDkim(domain) {
  const row = q('SELECT dkim_private, dkim_public FROM domains WHERE name = ?').get(domain);
  if (!row || row.dkim_private) return row;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const pub = publicKey.toString('base64');
  q('UPDATE domains SET dkim_private = ?, dkim_public = ? WHERE name = ?').run(privateKey, pub, domain);
  return { dkim_private: privateKey, dkim_public: pub };
}

// ---------- password hashes ----------
/** Keep the mailbox password in step with the account password (we only see it in plain text at these moments). */
/** Mail-app password: replaces the account password for mail apps (null = back to the account password). */
export function setMailAppPassword(userId, password) {
  q('UPDATE users SET mail_app_hash = ?, mail_app_created = ? WHERE id = ?').run(password ? dovecotHash(password) : null, password ? Date.now() : null, userId);
  scheduleMailConfig();
}

export function setMailPassword(userId, password) {
  q('UPDATE users SET mail_hash = ? WHERE id = ?').run(dovecotHash(password), userId);
  scheduleMailConfig();
}

// ---------- sign-in protection ----------
export const AUTH_POLICY_URL = process.env.AUTH_POLICY_URL || `http://workspace:${process.env.AUTH_POLICY_PORT || 8081}/`;
function policyConf() {
  let secret = getSetting('auth_policy_secret');
  if (!secret) { secret = crypto.randomBytes(24).toString('base64url'); setSetting('auth_policy_secret', secret); }
  let nonce = getSetting('auth_policy_nonce');
  if (!nonce) { nonce = crypto.randomBytes(16).toString('hex'); setSetting('auth_policy_nonce', nonce); }
  return [
    `auth_policy_server_url = ${AUTH_POLICY_URL}`,
    `auth_policy_server_api_header = X-Policy-Key: ${secret}`,
    `auth_policy_hash_nonce = ${nonce}`,
    'auth_policy_hash_truncate = 16',
    'auth_policy_request_attributes = login=%{requested_username} pwhash=%{hashed_password} remote=%{rip} protocol=%s',
    'auth_policy_check_before_auth = yes',
    'auth_policy_check_after_auth = yes',
    'auth_policy_report_after_auth = yes',
    'auth_policy_reject_on_fail = no',
    'auth_policy_server_timeout_msecs = 2000',
    '',
  ].join('\n');
}

// ---------- table generation ----------
const splitTargets = (s) => s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

export function buildMailConfig() {
  const domains = q('SELECT name, org_id, catchall FROM domains ORDER BY name').all();
  const users = q('SELECT id, org_id, username, name, mail_hash, mail_app_hash, mail_quota_mb, mail_home, disabled, is_admin FROM users ORDER BY username').all();
  const aliases = q('SELECT org_id, address, targets FROM aliases ORDER BY address').all();
  const userByAddress = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const aliasMap = new Map(aliases.map((a) => [a.address.toLowerCase(), splitTargets(a.targets)]).filter(([, t]) => t.length)); // a group with nobody in it yet: no address

  // RFC 2142: every domain must accept postmaster@ and abuse@. Route them to the company's admins.
  for (const d of domains) {
    const admins = users.filter((u) => u.org_id === d.org_id && u.is_admin && !u.disabled).map((u) => u.username);
    for (const role of ['postmaster', 'abuse']) {
      const addr = `${role}@${d.name}`;
      if (!userByAddress.has(addr) && !aliasMap.has(addr) && admins.length) aliasMap.set(addr, admins);
    }
  }

  const lines = (rows) => rows.join('\n') + (rows.length ? '\n' : '');
  const files = {
    'postfix/domains': lines(domains.map((d) => `${d.name} OK`)),
    // Disabled accounts keep receiving mail but cannot sign in (see nologin below).
    'postfix/mailboxes': lines(users.map((u) => `${u.username} OK`)),
    'postfix/aliases': lines([
      ...[...aliasMap].map(([addr, targets]) => `${addr} ${targets.join(',')}`),
      ...catchAllLines(domains, users, aliasMap),
    ]),
    // Who may send as which address: yourself, plus any alias you are a member of.
    'postfix/senders': lines([
      ...users.map((u) => `${u.username} ${u.username}`),
      ...[...aliasMap].map(([addr, targets]) => [addr, targets.filter((t) => userByAddress.has(t))])
        .filter(([, members]) => members.length).map(([addr, members]) => `${addr} ${members.join(',')}`),
    ]),
    'dovecot/passwd': lines(users.map((u) => {
      // "*" can never match: users who haven't signed in since email was enabled have no hash yet.
      // With a mail-app password, that is the only password mail apps accept.
      const pass = u.mail_app_hash || u.mail_hash || '{SHA512-CRYPT}*';
      const extra = [];
      if (u.disabled) extra.push('nologin=y', 'reason=Account_disabled');
      if (u.mail_quota_mb > 0) extra.push(`userdb_quota_rule=*:storage=${u.mail_quota_mb}M`);
      // Someone renamed (or given a fresh folder) keeps their mail in their own folder.
      if (u.mail_home) extra.push(`userdb_mail=maildir:${u.mail_home}/Maildir`);
      return `${u.username}:${pass}::::${u.mail_home || ''}::${extra.join(' ')}`; // user:pass:uid:gid:gecos:home:shell:extra
    })),
    'dovecot/masters': (webmailSecret(), `webmail:${getSetting('webmail_secret_hash')}\n`),
    // Sign-in protection: Dovecot (IMAP and Postfix SMTP AUTH) asks the app before/after each sign-in.
    'dovecot/policy.conf': policyConf(),
  };
  // Per-user Sieve: filter rules, then the vacation auto-reply (while enabled and not past its end date).
  const today = new Date().toISOString().slice(0, 10);
  const vacations = new Map(q('SELECT * FROM vacations WHERE enabled = 1').all()
    .filter((v) => !v.end_date || v.end_date >= today).map((v) => [v.user_id, v]));
  const ruleSets = new Map(q('SELECT user_id, rules FROM mail_rules').all().map((r) => [r.user_id, JSON.parse(r.rules)]));
  for (const u of users) {
    if (u.disabled) continue;
    const v = vacations.get(u.id);
    const addresses = [u.username, ...[...aliasMap].filter(([, t]) => t.includes(u.username)).map(([a]) => a)];
    const script = userSieve({ username: u.username, rules: ruleSets.get(u.id) || [], vacation: v ? { ...v, name: u.name, addresses } : null });
    if (script) files[`sieve/${u.username}.sieve`] = script;
  }
  for (const d of domains) {
    const k = ensureDkim(d.name);
    if (k?.dkim_private) files[`dkim/${d.name}.${DKIM_SELECTOR}.key`] = k.dkim_private;
  }
  return files;
}

/**
 * Catch-all: "@domain target". Postfix tries "user@domain" before "@domain" in this table, but
 * real mailboxes live in a different table, so each one gets an identity entry first; otherwise
 * the catch-all would take their mail too.
 */
function catchAllLines(domains, users, aliasMap) {
  const out = [];
  for (const d of domains.filter((x) => x.catchall)) {
    for (const u of users) {
      if (u.username.endsWith(`@${d.name}`) && !aliasMap.has(u.username)) out.push(`${u.username} ${u.username}`);
    }
    out.push(`@${d.name} ${d.catchall}`);
  }
  return out;
}

/** Write the tables atomically; remove DKIM keys of domains that no longer exist. */
export function writeMailConfig(dir = MAIL_CONFIG_DIR) {
  if (!dir) return false;
  const files = buildMailConfig();
  for (const sub of ['postfix', 'dovecot', 'dkim', 'sieve']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o750 });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    let current = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch {}
    if (current === content) continue; // unchanged: don't trigger a reload
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o640 });
    fs.renameSync(tmp, target);
  }
  for (const sub of ['dkim', 'sieve']) {
    for (const f of fs.readdirSync(path.join(dir, sub))) {
      if (!files[`${sub}/${f}`]) fs.rmSync(path.join(dir, sub, f), { force: true });
    }
  }
  return true;
}

let timer = null;
/** Debounced write after any change that affects mail (users, aliases, domains, passwords). */
export function scheduleMailConfig() {
  if (!MAIL_CONFIG_DIR) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { writeMailConfig(); } catch (e) { console.error('Writing mail configuration failed:', e); }
  }, 300);
  timer.unref?.();
}
