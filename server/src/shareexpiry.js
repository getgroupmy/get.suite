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

export const MAX_SHARE_DAYS = 366;

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
  setInterval(() => { try { expireShares(); } catch (e) { console.error('[share expiry]', e.message); } }, 60e3).unref();
}
