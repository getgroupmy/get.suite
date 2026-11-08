import { q } from './db.js';

// Shared with the whole company: a file or folder can give everyone in its owner's company a role
// (viewer or editor), including people who join later.
if (!q('PRAGMA table_info(files)').all().some((c) => c.name === 'org_role')) q('ALTER TABLE files ADD COLUMN org_role TEXT').run();

const RANK = { viewer: 1, commenter: 1.5, editor: 2, owner: 3 }; // commenter: reads, and comments

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
    const f = q('SELECT f.id, f.owner_id, f.parent_id, f.org_role, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(cur);
    if (!f) return best;
    if (f.owner_id === userId) return 'owner';
    if (f.org_role && f.org_id === userOrg && (!best || RANK[f.org_role] > RANK[best])) best = f.org_role;
    let s = q('SELECT role, expires_at FROM shares WHERE file_id = ? AND user_id = ?').get(f.id, userId);
    // Shared until a time that has passed: only what groups give them counts (the sweep tidies up soon).
    if (s?.expires_at && s.expires_at <= Date.now()) s = q(`SELECT gs.role FROM group_shares gs JOIN group_members m ON m.group_id = gs.group_id
                                                            WHERE gs.file_id = ? AND m.user_id = ? ORDER BY CASE gs.role WHEN 'editor' THEN 0 WHEN 'commenter' THEN 1 ELSE 2 END LIMIT 1`).get(f.id, userId);
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
    const f = q('SELECT f.owner_id, f.parent_id, f.org_role, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(cur);
    if (!f) break;
    ids.add(f.owner_id);
    if (f.org_role) for (const u of q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(f.org_id)) ids.add(u.id);
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

/**
 * "Viewers can't download, print or copy" (a file's owner can set it): may someone with this role
 * take the file's content away (download, export, copy, sync)? Editors and the owner always can.
 */
export const mayTakeAway = (file, role) => !file?.no_download || atLeast(role || '', 'editor');
