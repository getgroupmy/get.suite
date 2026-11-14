// Settings → Recent security activity: your own sign-ins (and attempts), and changes to how you
// sign in, from the activity log, in words written for you ("You signed in", "Someone tried…").
import { q } from './db.js';

const DAY = 86400000;
const SIGN_IN_HOW = { code: 'with a code', recovery: 'with a recovery code', passkey: 'with a passkey', 'password-passkey': 'with a password and a passkey' };
const FAILED_WHY = { password: 'wrong password', code: 'wrong code', disabled: 'your account was suspended', passkey: 'a passkey that didn’t check out' };

/** What happened, said to you. `by` is someone else who did it (an admin), or null. */
const WORDS = {
  'sign-in': (d) => `You signed in${d?.twoStep ? ` ${SIGN_IN_HOW[d.twoStep] || ''}` : d?.how ? ` ${SIGN_IN_HOW[d.how] || ''}` : ''}`.trimEnd(),
  'sign-in.failed': (d) => `Someone tried to sign in as you${d?.reason ? `: ${FAILED_WHY[d.reason] || 'it didn’t check out'}` : ''}`,
  'password.change': () => 'Your password was changed',
  'password.reset_requested': () => 'A password reset link was sent to your recovery email',
  'password.reset': () => 'Your password was reset with an emailed link',
  '2fa.on': () => 'Two-step verification was turned on',
  '2fa.off': () => 'Two-step verification was turned off',
  'passkey.added': () => 'A passkey was added',
  'passkey.removed': () => 'A passkey was removed',
  'recovery.set': () => 'Your recovery email was set',
  'recovery.remove': () => 'Your recovery email was removed',
  'mail-app.create': () => 'A mail-app password was made',
  'mail-app.remove': () => 'The mail-app password was removed',
  'session.revoke': (d) => (d?.devices ? `${d.devices} device${d.devices === 1 ? ' was' : 's were'} signed out` : 'A device was signed out'),
  'api_token.create': () => 'An API token was made',
  'api_token.revoke': () => 'An API token was revoked',
  'mail.forwarding_on': () => 'Forwarding of your mail was turned on',
  'mail.forwarding_off': () => 'Forwarding of your mail was turned off',
};
export const SECURITY_ACTIONS = Object.keys(WORDS);
/** Ones worth a second look when you don't remember them. */
const WARN = new Set(['sign-in.failed', '2fa.off', 'passkey.removed', 'recovery.remove', 'mail.forwarding_on', 'password.reset']);

/**
 * The last `days` of it, newest first (at most `limit`). Sign-ins and attempts are found by your
 * address (they're recorded before anyone is signed in); changes by who made them or whose they were.
 */
export function securityActivity(user, { days = 30, limit = 100, now = Date.now() } = {}) {
  const marks = SECURITY_ACTIONS.map(() => '?').join(', ');
  const rows = q(`SELECT id, at, actor_id, actor_name, action, target, details, ip FROM audit_log
    WHERE at > ? AND action IN (${marks}) AND (actor_id = ? OR (target = ? AND action IN ('sign-in', 'sign-in.failed', 'password.change', '2fa.off', 'session.revoke', 'password.reset', 'password.reset_requested')))
    ORDER BY id DESC LIMIT ?`).all(now - days * DAY, ...SECURITY_ACTIONS, user.id, user.username, limit * 3 + 1);
  // An admin's own row about someone else (signing out their devices, revoking their token) isn't yours.
  const aboutSomeoneElse = (r) => r.actor_id === user.id && r.target !== user.username && !r.action.startsWith('mail.forwarding')
    && /@/.test(r.target || '') && !String(r.target).includes(`(${user.username})`);
  const mine = rows.filter((r) => !aboutSomeoneElse(r));
  const entries = mine.slice(0, limit).map((r) => {
    let d = null;
    try { d = r.details ? JSON.parse(r.details) : null; } catch { /* not JSON */ }
    const by = r.actor_id && r.actor_id !== user.id ? r.actor_name || 'An admin' : null;
    return { id: r.id, at: r.at, action: r.action, text: WORDS[r.action](d), by, ip: r.ip || null, warn: WARN.has(r.action) };
  });
  const failed = entries.filter((e) => e.action === 'sign-in.failed').length;
  return { entries, more: mine.length > limit, days, failed };
}
