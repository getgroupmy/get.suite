// Security alerts: things a company's admins should hear about at once, as a notification (kind
// "security", which each admin can turn off): someone made or unmade an admin, two-step
// verification turned off or reset, repeated failed sign-ins on one account, and a person's data
// downloaded by an admin. Raised from the activity log as entries are written.
import { q } from './db.js';
import { notify } from './notifications.js';

const FAILS = 5, FAIL_WINDOW = 15 * 60e3, QUIET = 60 * 60e3; // 5 failures in 15 minutes; then at most hourly per account
const lastFailAlert = new Map();

const adminsOf = (orgId, except) => q('SELECT id FROM users WHERE org_id = ? AND is_admin = 1 AND disabled = 0').all(orgId).map((u) => u.id).filter((id) => id !== except);

/** Called by audit() after an entry is written. */
export function securityAlert({ orgId, action, actor, target, details, at = Date.now() }) {
  if (!orgId) return;
  const by = actor?.name || actor?.username || 'Someone';
  const send = (title, body = null) => {
    const to = adminsOf(orgId, actor?.id);
    if (to.length) notify(to, { kind: 'security', title, body, link: '/admin?tab=activity', actor: actor?.name || null });
  };
  if (action === 'user.update' && details) {
    if (details.is_admin === true) send(`${by} made ${target} an admin`);
    if (details.is_admin === false) send(`${by} took away ${target}'s admin rights`);
    if (details.reset_two_factor) send(`${by} reset two-step verification for ${target}`, 'They can sign in with just their password until they set it up again.');
  }
  if (action === '2fa.off') send(`${by} turned off two-step verification`, 'Their account is protected by their password alone now.');
  if (action === 'data.export' && target && actor && target !== actor.username) send(`${by} downloaded ${target}'s data`);
  if (action === 'sign-in.failed' && target) {
    const n = q("SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND action = 'sign-in.failed' AND target = ? AND at > ?").get(orgId, target, at - FAIL_WINDOW).n;
    const key = `${orgId}:${target}`;
    if (n >= FAILS && !(lastFailAlert.get(key) > at - QUIET)) {
      lastFailAlert.set(key, at);
      const to = adminsOf(orgId, null);
      if (to.length) notify(to, { kind: 'security', title: `${n} failed sign-ins for ${target} in the last 15 minutes`, body: 'Someone may be guessing the password. Admin → Activity shows where from.', link: '/admin?tab=activity' });
    }
  }
}

// A sign-in on a device (browser and system) this account hasn't used before: its owner is told, so
// they can spot one that wasn't them (on their other devices, live). The very first sign-in isn't news.
q(`CREATE TABLE IF NOT EXISTS known_devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device)
)`).run();
export function newDeviceSignIn(userId, device, ip, at = Date.now()) {
  const known = q('SELECT device FROM known_devices WHERE user_id = ?').all(userId).map((r) => r.device);
  if (known.includes(device)) return false;
  q('INSERT OR IGNORE INTO known_devices (user_id, device, first_at) VALUES (?, ?, ?)').run(userId, device, at);
  if (!known.length) return false;
  notify([userId], { kind: 'signin', title: `New sign-in to your account on ${device}`, body: `From ${ip || 'an unknown address'}. If it wasn't you, change your password and sign that device out in Settings.`, link: '/settings' });
  return true;
}

/** A passkey added to (or removed from) someone's account: they're told, on all their devices, in case it wasn't them. */
export function passkeyChanged(userId, { added, name, device }) {
  notify([userId], added
    ? { kind: 'signin', title: `A passkey was added to your account: “${name}”`, body: `On ${device || 'a device'}. If it wasn't you, remove it in Settings → Passkeys and change your password.`, link: '/settings' }
    : { kind: 'signin', title: `A passkey was removed from your account: “${name}”`, body: 'It no longer signs you in.', link: '/settings' });
}
