// Access that ends by itself: sharing a file with someone "until" a date. When it's reached they
// lose what they were given one by one (a group they're in may still give them access), the owner
// is told, and open windows update. roleFor already ignores an expired share in the meantime.
import { q } from './db.js';
import { sync } from './groups.js';
import { audienceFor } from './access.js';
import { sendTo } from './hub.js';
import { notify as bell } from './notifications.js';
import { recordActivity } from './fileactivity.js';

if (!q('PRAGMA table_info(shares)').all().some((c) => c.name === 'expires_at')) q('ALTER TABLE shares ADD COLUMN expires_at INTEGER').run();
// When someone was shared a file directly, and by whom (Home → Shared with you); null for older shares.
for (const col of ['shared_at INTEGER', 'shared_by TEXT']) if (!q('PRAGMA table_info(shares)').all().some((c) => c.name === col.split(' ')[0])) q(`ALTER TABLE shares ADD COLUMN ${col}`).run();

// The end a share was last warned about (a new end date warns again).
if (!q('PRAGMA table_info(shares)').all().some((c) => c.name === 'warned_for')) q('ALTER TABLE shares ADD COLUMN warned_for INTEGER').run();

export const MAX_SHARE_DAYS = 366;
export const WARN_DAYS = 3;

/**
 * A few days before someone's access ends: tell them (and who to ask) and the owner (who can extend it),
 * once for each end date. Returns how many shares were warned about.
 */
export function warnEndingShares(at = Date.now()) {
  const rows = q(`SELECT s.file_id, s.user_id, s.expires_at, f.owner_id, f.name, f.kind, u.name AS who, o.name AS owner_name FROM shares s
                  JOIN files f ON f.id = s.file_id JOIN users u ON u.id = s.user_id JOIN users o ON o.id = f.owner_id
                  WHERE s.direct_role IS NOT NULL AND s.expires_at > ? AND s.expires_at <= ? AND (s.warned_for IS NULL OR s.warned_for != s.expires_at) AND f.trashed = 0`)
    .all(at, at + WARN_DAYS * 864e5);
  const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  for (const r of rows) {
    q('UPDATE shares SET warned_for = expires_at WHERE file_id = ? AND user_id = ?').run(r.file_id, r.user_id);
    const open = r.kind === 'doc' ? `/docs/${r.file_id}` : r.kind === 'sheet' ? `/sheets/${r.file_id}` : r.kind === 'slides' ? `/slides/${r.file_id}` : '/drive/shared';
    bell([r.user_id], { kind: 'share', title: `Your access to “${r.name}” ends ${day(r.expires_at)}`, body: `Shared by ${r.owner_name} until then. Ask them if you still need it.`, link: open, actor: r.owner_name });
    bell([r.owner_id], { kind: 'share', title: `${r.who}'s access to “${r.name}” ends ${day(r.expires_at)}`, body: 'Open its Share window to give them longer.', link: '/drive/sharedbyme', actor: r.who });
  }
  return rows.length;
}

/** Take away the shares whose time is up (now or before `at`); returns how many. */
export function expireShares(at = Date.now()) {
  const rows = q(`SELECT s.file_id, s.user_id, f.owner_id, f.name, f.parent_id, u.name AS who FROM shares s JOIN files f ON f.id = s.file_id JOIN users u ON u.id = s.user_id
                  WHERE s.expires_at IS NOT NULL AND s.expires_at <= ? AND s.direct_role IS NOT NULL`).all(at);
  for (const r of rows) {
    const before = audienceFor(r.file_id);
    q('UPDATE shares SET direct_role = NULL, expires_at = NULL WHERE file_id = ? AND user_id = ?').run(r.file_id, r.user_id);
    sync(r.file_id);
    recordActivity(r.file_id, r.owner_id, 'share', { removed: [`${r.who} (access ended)`] });
    bell([r.owner_id], { kind: 'share', title: `${r.who}'s access to “${r.name}” has ended`, body: 'It was shared until today. Share it again if they still need it.', link: '/drive/shared', actor: r.who });
    sendTo(new Set([...before, r.user_id]), { type: 'files-changed', parent_id: r.parent_id });
  }
  return rows.length;
}

export function startShareExpiry() {
  setInterval(() => { try { expireShares(); warnEndingShares(); } catch (e) { console.error('[share expiry]', e.message); } }, 60e3).unref();
}
