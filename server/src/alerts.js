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
