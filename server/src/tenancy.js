import fs from 'node:fs';
import path from 'node:path';
import { q, FILES_DIR } from './db.js';
import { uid, now, str, bad, HttpError } from './util.js';
import { newUserRow, validatePassword } from './auth.js';

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validDomain(v) {
  const d = str(v, { required: true, name: 'Domain', max: 253 }).toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) throw bad(`“${d}” is not a valid domain name`);
  return d;
}

/** Validate local@domain where the domain belongs to orgId. Returns the normalised address. */
export function validAddress(local, domain, orgId) {
  const l = str(local, { required: true, name: 'Address', max: 64 }).toLowerCase();
  if (!LOCAL_RE.test(l) || l.includes('..')) throw bad('The part before @ may contain letters, numbers, dots, dashes and underscores');
  const d = validDomain(domain);
  const row = q('SELECT org_id FROM domains WHERE name = ?').get(d);
  if (!row || row.org_id !== orgId) throw bad(`${d} is not a domain of this company`);
  const address = `${l}@${d}`;
  if (q('SELECT 1 FROM users WHERE username = ?').get(address) || q('SELECT 1 FROM aliases WHERE address = ?').get(address)) {
    throw bad(`${address} is already taken`);
  }
  return address;
}

/** The folder that holds someone's mail on the mail server. */
export const defaultMailHome = (address) => { const [local, domain] = address.split('@'); return `/var/vmail/${domain}/${local}`; };
export const mailHomeOf = (u) => u.mail_home || defaultMailHome(u.username);

/** A mail folder for a new address: the usual one, unless someone's mail is (or was) kept there. */
export function freshMailHome(address, id) {
  const usual = defaultMailHome(address);
  const taken = q('SELECT 1 FROM retired_mail_homes WHERE path = ?').get(usual) || q('SELECT 1 FROM users WHERE mail_home = ?').get(usual);
  return taken ? `${usual}.${id.slice(0, 8)}` : null;
}
/** Remember that a mail folder belonged to someone, so it's never given to anyone else. */
export const retireMailHome = (u) => q('INSERT OR IGNORE INTO retired_mail_homes (path, retired_at) VALUES (?, ?)').run(mailHomeOf(u), Date.now());

export function addDomain(orgId, name) {
  const d = validDomain(name);
  if (q('SELECT 1 FROM domains WHERE name = ?').get(d)) throw bad(`${d} is already in use`);
  q('INSERT INTO domains (name, org_id, created_at) VALUES (?, ?, ?)').run(d, orgId, now());
  return d;
}

export function ensureGeneralChannel(orgId) {
  if (!q('SELECT 1 FROM channels WHERE org_id = ? AND dm_key IS NULL').get(orgId)) {
    q('INSERT INTO channels (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(uid(), orgId, 'general', now());
  }
}

/** Create a company with its first domain and first admin. Call inside a transaction. */
export function createOrg({ name, domain, adminName, adminLocal, adminPassword, isSuper = false }) {
  const orgName = str(name, { required: true, name: 'Company name', max: 100 });
  validatePassword(adminPassword);
  const id = uid();
  q('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(id, orgName, now());
  const d = addDomain(id, domain);
  const address = validAddress(adminLocal, d, id);
  const userId = newUserRow({
    orgId: id, username: address, password: adminPassword, is_admin: true, is_super: isSuper,
    name: str(adminName, { required: true, name: 'Admin name', max: 100 }),
  });
  ensureGeneralChannel(id);
  return { id, userId, address };
}

export function orgSettings(orgId) {
  return q('SELECT id, name, allow_external, quota_mb FROM orgs WHERE id = ?').get(orgId);
}

/**
 * May these two users interact (share files, direct-message)?
 * Same company: always. Different companies: only if both allow external collaboration.
 */
export function canReach(user, otherUserId) {
  const other = q(`SELECT u.org_id, o.allow_external FROM users u JOIN orgs o ON o.id = u.org_id
                   WHERE u.id = ? AND u.disabled = 0`).get(otherUserId);
  if (!other) return false;
  if (other.org_id === user.org_id) return true;
  return !!other.allow_external && !!orgSettings(user.org_id)?.allow_external;
}

export function orgMemberIds(orgId) {
  return q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(orgId).map((r) => r.id);
}

export function orgStorageUsed(orgId) {
  // Earlier versions count too.
  return q('SELECT COALESCE(SUM(f.size), 0) AS n FROM files f JOIN users u ON u.id = f.owner_id WHERE u.org_id = ?').get(orgId).n
    + q('SELECT COALESCE(SUM(v.size), 0) AS n FROM file_versions v JOIN files f ON f.id = v.file_id JOIN users u ON u.id = f.owner_id WHERE u.org_id = ?').get(orgId).n;
}

/** Throw 413 if adding `bytes` would exceed the company's quota. */
export function checkQuota(orgId, bytes) {
  const org = orgSettings(orgId);
  if (!org?.quota_mb) return;
  if (orgStorageUsed(orgId) + bytes > org.quota_mb * 1024 * 1024) {
    throw new HttpError(413, `Your company's storage quota (${org.quota_mb} MB) is full`);
  }
}

/**
 * Stored blobs that will disappear when the given users are deleted: their files,
 * plus anything inside their folders (removed by cascade). Call before deleting.
 */
export function blobsOwnedBy(userIdsSql, ...params) {
  return q(`WITH RECURSIVE t(id) AS (
              SELECT id FROM files WHERE owner_id IN (${userIdsSql})
              UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id)
            SELECT storage FROM files WHERE id IN (SELECT id FROM t) AND storage IS NOT NULL
            UNION ALL SELECT storage FROM file_versions WHERE file_id IN (SELECT id FROM t) AND storage IS NOT NULL`).all(...params).map((r) => r.storage);
}

export function removeBlobs(list) {
  for (const s of list) fs.rm(path.join(FILES_DIR, s), { force: true }, () => {});
}
