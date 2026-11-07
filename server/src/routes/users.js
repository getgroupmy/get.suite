import { disable as disableTwoFactor } from '../twofactor.js';
import { audit } from '../audit.js';
import { Router } from 'express';
import { q, tx } from '../db.js';
import { str, bad, notFound, forbidden } from '../util.js';
import { requireAdmin, validatePassword, hashPassword, newUserRow } from '../auth.js';
import { validAddress, canReach, blobsOwnedBy, removeBlobs, mailHomeOf, retireMailHome } from '../tenancy.js';
import { uid } from '../util.js';
import { sendTo } from '../hub.js';

/** A status as shown, or null once it has cleared. */
export function statusOf(row, at = Date.now()) {
  if (!row || (!row.status_emoji && !row.status_text) || (row.status_until && row.status_until <= at)) return null;
  return { emoji: row.status_emoji || null, text: row.status_text || null, until: row.status_until || null };
}
/** Colleagues (and the person's other tabs) see a status change at once. */
const statusChanged = (user) => sendTo(q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(user.org_id).map((u) => u.id), { type: 'status-changed', user_id: user.id });
import { forgetConnection } from '../mail/imap.js';
import { setMailPassword, scheduleMailConfig } from '../mail/config.js';

/** Which company an admin request acts on: their own, or any (platform owner, via ?org_id=). */
function targetOrg(req) {
  const id = req.query.org_id || req.body?.org_id;
  if (id && id !== req.user.org_id) {
    if (!req.user.is_super) throw forbidden('You can only manage your own company');
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw notFound('Company not found');
    return id;
  }
  return req.user.org_id;
}

function loadManagedUser(req) {
  const u = q('SELECT id, org_id, is_super, username, mail_home FROM users WHERE id = ?').get(req.params.id);
  if (!u || (u.org_id !== req.user.org_id && !req.user.is_super)) throw notFound();
  return u;
}

/**
 * Give someone a new address. Their mailbox, files, calendar and chats stay theirs (all linked by
 * account, not address); aliases, catch-alls and signatures follow the new address. The old address
 * can stay as an alias, so mail sent to it still arrives (and they can still send as it).
 */
function renameAddress(u, address, keepOld) {
  const old = u.username;
  tx(() => {
    q('UPDATE users SET username = ?, email = ?, mail_home = ? WHERE id = ?').run(address, address, mailHomeOf(u), u.id);
    for (const a of q('SELECT id, targets FROM aliases WHERE org_id = ?').all(u.org_id)) {
      const targets = a.targets.split(',').map((t) => t.trim());
      if (targets.some((t) => t.toLowerCase() === old)) {
        q('UPDATE aliases SET targets = ? WHERE id = ?').run([...new Set(targets.map((t) => (t.toLowerCase() === old ? address : t)))].join(', '), a.id);
      }
    }
    q('UPDATE domains SET catchall = ? WHERE catchall = ?').run(address, old);
    q('UPDATE identity_signatures SET address = ? WHERE user_id = ? AND address = ?').run(address, u.id, old);
    if (keepOld) q('INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), u.org_id, old, address, Date.now());
  });
  forgetConnection(u.id); // webmail reconnects under the new address
  u.username = address;
}

export default function userRoutes() {
  const r = Router();

  // Everyone: your own company's directory (for sharing, chat, contacts).
  r.get('/directory', (req, res) => {
    res.json(q('SELECT id, username, name, status_emoji, status_text, status_until FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name')
      .all(req.user.org_id).map(({ status_emoji, status_text, status_until, ...u }) => ({ ...u, status: statusOf({ status_emoji, status_text, status_until }) })));
  });

  // Your status: what colleagues see next to your name, until it clears by itself.
  r.get('/me/status', (req, res) => {
    res.json({ status: statusOf(q('SELECT status_emoji, status_text, status_until FROM users WHERE id = ?').get(req.user.id)) });
  });
  r.put('/me/status', (req, res) => {
    const text = str(req.body.text, { max: 100, name: 'Status' }) || null;
    const emoji = String(req.body.emoji || '').trim() || null;
    if (emoji && (emoji.length > 16 || /[\s<>]/.test(emoji))) throw bad('Choose an emoji');
    if (!text && !emoji) throw bad('Type a status or choose an emoji');
    let until = req.body.until == null ? null : Number(req.body.until);
    if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw bad('Pick a time in the future to clear it');
    if (until !== null && until > Date.now() + 366 * 864e5) throw bad('A status can last up to a year');
    q('UPDATE users SET status_emoji = ?, status_text = ?, status_until = ? WHERE id = ?').run(emoji, text, until, req.user.id);
    statusChanged(req.user);
    res.json({ status: statusOf({ status_emoji: emoji, status_text: text, status_until: until }) });
  });
  r.delete('/me/status', (req, res) => {
    q('UPDATE users SET status_emoji = NULL, status_text = NULL, status_until = NULL WHERE id = ?').run(req.user.id);
    statusChanged(req.user);
    res.json({ status: null });
  });

  // Find someone in another company by exact address (only if both companies allow it).
  r.get('/lookup', (req, res) => {
    const address = String(req.query.email || '').trim().toLowerCase();
    const u = q(`SELECT u.id, u.username, u.name, o.name AS org_name FROM users u JOIN orgs o ON o.id = u.org_id
                 WHERE u.username = ? AND u.disabled = 0`).get(address);
    if (!u || !canReach(req.user, u.id)) throw notFound(`No reachable person has the address ${address}`);
    res.json(u);
  });

  r.use(requireAdmin);

  r.get('/', (req, res) => {
    const orgId = targetOrg(req);
    res.json(q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.created_at, u.mail_quota_mb,
                  (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used,
                  (SELECT COUNT(*) FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AS two_factor
                FROM users u WHERE u.org_id = ? ORDER BY u.name`).all(orgId));
  });

  r.post('/', (req, res) => {
    const orgId = targetOrg(req);
    const username = validAddress(req.body.local, req.body.domain, orgId);
    const name = str(req.body.name, { required: true, name: 'Name', max: 100 });
    validatePassword(req.body.password);
    const id = newUserRow({ orgId, username, name, password: req.body.password, is_admin: !!req.body.is_admin });
    audit(req, 'user.create', { org: orgId, target: username, details: { admin: !!req.body.is_admin } });
    res.status(201).json({ id, username });
  });

  r.patch('/:id', (req, res) => {
    const u = loadManagedUser(req);
    const self = u.id === req.user.id;
    const { name, is_admin, disabled, password, mail_quota_mb, reset_two_factor } = req.body;
    if (u.is_super && !req.user.is_super) throw forbidden('Only the platform owner can change this account');
    // A new address (another name, or another of the company's domains). Mail stays where it is.
    if (req.body.local !== undefined || req.body.domain !== undefined) {
      const [oldLocal, oldDomain] = u.username.split('@');
      const local = String(req.body.local ?? oldLocal).trim().toLowerCase(), domain = String(req.body.domain ?? oldDomain).trim().toLowerCase();
      if (`${local}@${domain}` !== u.username) renameAddress(u, validAddress(local, domain, u.org_id), req.body.keep_old_address !== false);
    }
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), u.id);
    if (is_admin !== undefined) {
      if (self && !is_admin) throw bad('You cannot remove your own admin rights');
      q('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, u.id);
    }
    if (disabled !== undefined) {
      if (self) throw bad('You cannot disable yourself');
      q('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id);
      if (disabled) q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (password !== undefined) {
      validatePassword(password);
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      setMailPassword(u.id, password);
      // A reset (e.g. after a break-in) also removes the mail-app password, so only the new password works anywhere.
      q('UPDATE users SET mail_app_hash = NULL, mail_app_created = NULL WHERE id = ?').run(u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    // Lost phone: turn off their two-step verification so they can sign in with the password and set
    // it up again. Their sessions end, so the change is noticed.
    if (reset_two_factor) {
      if (self) throw bad('Turn off your own two-step verification in Settings');
      disableTwoFactor(u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (mail_quota_mb !== undefined) {
      const mb = Math.trunc(Number(mail_quota_mb));
      if (!Number.isFinite(mb) || mb < 0) throw bad('Mailbox size must be 0 (unlimited) or more');
      q('UPDATE users SET mail_quota_mb = ? WHERE id = ?').run(mb, u.id);
    }
    scheduleMailConfig();
    const changed = Object.fromEntries(Object.entries({ name, is_admin, disabled, mail_quota_mb, reset_two_factor, password: password !== undefined ? 'reset' : undefined,
      address: req.body.local !== undefined || req.body.domain !== undefined ? q('SELECT username FROM users WHERE id = ?').get(u.id)?.username : undefined }).filter(([, v]) => v !== undefined));
    if (Object.keys(changed).length) audit(req, 'user.update', { org: u.org_id, target: u.username, details: changed });
    res.json({ ok: true });
  });

  // Permanently delete a user and everything they own.
  r.delete('/:id', (req, res) => {
    const u = loadManagedUser(req);
    if (u.id === req.user.id) throw bad('You cannot delete yourself');
    if (u.is_super) throw bad('The platform owner account cannot be deleted');
    const blobs = tx(() => {
      const list = blobsOwnedBy('?', u.id);
      q('UPDATE domains SET catchall = NULL WHERE catchall = (SELECT username FROM users WHERE id = ?)').run(u.id);
      // Their mail stays on the mail server; whoever gets this address next starts with an empty mailbox.
      retireMailHome(q('SELECT username, mail_home FROM users WHERE id = ?').get(u.id));
      q('DELETE FROM users WHERE id = ?').run(u.id);
      return list;
    });
    removeBlobs(blobs);
    scheduleMailConfig();
    audit(req, 'user.delete', { org: u.org_id, target: u.username });
    res.json({ ok: true });
  });

  return r;
}
