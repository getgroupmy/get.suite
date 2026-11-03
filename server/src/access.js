import { q } from './db.js';

const RANK = { viewer: 1, editor: 2, owner: 3 };

/** Do two companies currently allow collaborating with each other? */
function orgsMayCollaborate(orgA, orgB) {
  if (orgA === orgB) return true;
  const rows = q('SELECT allow_external FROM orgs WHERE id IN (?, ?)').all(orgA, orgB);
  return rows.length === 2 && rows.every((r) => r.allow_external);
}

/**
 * Effective role of a user on a file: 'owner' | 'editor' | 'viewer' | null.
 * Walks up the folder chain: owning (or being shared) any ancestor grants access.
 * A share across companies only counts while both companies allow external
 * collaboration, so switching it off revokes access immediately.
 */
export function roleFor(fileId, userId) {
  const userOrg = q('SELECT org_id FROM users WHERE id = ?').get(userId)?.org_id;
  let best = null;
  let cur = fileId;
  for (let depth = 0; cur && depth < 64; depth++) {
    const f = q('SELECT f.id, f.owner_id, f.parent_id, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(cur);
    if (!f) return best;
    if (f.owner_id === userId) return 'owner';
    const s = q('SELECT role FROM shares WHERE file_id = ? AND user_id = ?').get(f.id, userId);
    if (s && (!best || RANK[s.role] > RANK[best]) && orgsMayCollaborate(f.org_id, userOrg)) best = s.role;
    cur = f.parent_id;
  }
  return best;
}

export function atLeast(role, needed) {
  return !!role && RANK[role] >= RANK[needed];
}

/** Everyone who can see a file (owners and sharees of it and its ancestors). */
export function audienceFor(fileId) {
  const ids = new Set();
  let cur = fileId;
  for (let depth = 0; cur && depth < 64; depth++) {
    const f = q('SELECT owner_id, parent_id FROM files WHERE id = ?').get(cur);
    if (!f) break;
    ids.add(f.owner_id);
    for (const s of q('SELECT user_id FROM shares WHERE file_id = ?').all(cur)) ids.add(s.user_id);
    cur = f.parent_id;
  }
  return [...ids];
}

/** IDs of a file and all of its descendants. */
export function subtreeIds(fileId) {
  return q(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id)
            SELECT id FROM t`).all(fileId).map((r) => r.id);
}
