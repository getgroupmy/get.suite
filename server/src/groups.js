// Groups: named sets of colleagues ("Marketing", "Managers") that admins keep up to date. A file or
// folder shared with a group is shared with everyone in it, now and later: joining a group gives its
// shared files, leaving takes them away.
//
// The shares table keeps each person's effective role on a file (so every access check stays the same);
// direct_role is what they were given one by one, and group_shares what groups were given. sync()
// works out the effective role from both whenever either changes.
import { Router } from 'express';
import { q, tx, widenRoles } from './db.js';
import { uid, now, str, bad, notFound } from './util.js';
import { requireAdmin } from './auth.js';
import { sendTo } from './hub.js';
import { audit } from './audit.js';
import { notify as bell } from './notifications.js';

q(`CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
)`).run();
q(`CREATE TABLE IF NOT EXISTS group_shares (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
  PRIMARY KEY (file_id, group_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS group_shares_group ON group_shares(group_id)').run();
widenRoles('group_shares'); // older databases: commenters too
if (!q('PRAGMA table_info(shares)').all().some((c) => c.name === 'direct_role')) {
  q('ALTER TABLE shares ADD COLUMN direct_role TEXT').run();
  q('UPDATE shares SET direct_role = role').run(); // every share so far was given directly
}

const RANK = { viewer: 1, commenter: 1.5, editor: 2 };
const best = (a, b) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
export const MAX_GROUPS = 200;

/** Bring the effective shares of one file in line with its direct and group shares. Returns who gained access. */
export function sync(fileId) {
  const f = q('SELECT owner_id FROM files WHERE id = ?').get(fileId);
  if (!f) return [];
  const want = new Map(); // user -> role from groups
  for (const g of q(`SELECT m.user_id, gs.role FROM group_shares gs JOIN group_members m ON m.group_id = gs.group_id
                     JOIN users u ON u.id = m.user_id WHERE gs.file_id = ? AND u.disabled = 0`).all(fileId)) {
    if (g.user_id !== f.owner_id) want.set(g.user_id, best(want.get(g.user_id), g.role));
  }
  const rows = q('SELECT user_id, role, direct_role FROM shares WHERE file_id = ?').all(fileId);
  const gained = [];
  for (const r of rows) {
    const role = best(r.direct_role, want.get(r.user_id));
    if (!role) q('DELETE FROM shares WHERE file_id = ? AND user_id = ?').run(fileId, r.user_id);
    else if (role !== r.role) q('UPDATE shares SET role = ? WHERE file_id = ? AND user_id = ?').run(role, fileId, r.user_id);
    want.delete(r.user_id);
  }
  for (const [userId, role] of want) {
    q('INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, ?, NULL)').run(fileId, userId, role);
    gained.push(userId);
  }
  return gained;
}

/** Re-sync every file shared with these groups (after members join or leave). */
export function syncGroups(groupIds) {
  const files = new Set();
  for (const g of groupIds) for (const r of q('SELECT file_id FROM group_shares WHERE group_id = ?').all(g)) files.add(r.file_id);
  for (const f of files) sync(f);
  return files.size;
}

export const groupsOf = (fileId) => q(`SELECT gs.group_id, gs.role, g.name, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members
                                       FROM group_shares gs JOIN groups g ON g.id = gs.group_id WHERE gs.file_id = ? ORDER BY g.name`).all(fileId);

/** Set which groups a file is shared with ([{ group_id, role }]); groups must be in this company. Returns who gained access. */
export function setFileGroups(fileId, orgId, list) {
  if (!Array.isArray(list)) throw bad('groups must be a list');
  return tx(() => {
    q('DELETE FROM group_shares WHERE file_id = ?').run(fileId);
    for (const s of list) {
      if (!['viewer', 'commenter', 'editor'].includes(s.role)) throw bad('role must be viewer, commenter or editor');
      if (!q('SELECT 1 FROM groups WHERE id = ? AND org_id = ?').get(String(s.group_id), orgId)) throw bad('No such group in your company');
      q('INSERT OR REPLACE INTO group_shares (file_id, group_id, role) VALUES (?, ?, ?)').run(fileId, String(s.group_id), s.role);
    }
    return sync(fileId);
  });
}

const describe = (g) => ({ ...g, members: q(`SELECT u.id, u.name, u.username FROM group_members m JOIN users u ON u.id = m.user_id
                                             WHERE m.group_id = ? ORDER BY u.name`).all(g.id),
  files: q('SELECT COUNT(*) AS n FROM group_shares WHERE group_id = ?').get(g.id).n });

/** /api/groups: everyone sees their company's groups (to share with them); admins change them. */
export function groupRoutes() {
  const r = Router();
  r.get('/', (req, res) => {
    res.json(q('SELECT * FROM groups WHERE org_id = ? ORDER BY name COLLATE NOCASE').all(req.user.org_id).map(describe));
  });
  const load = (req) => {
    const g = q('SELECT * FROM groups WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!g) throw notFound('Group not found');
    return g;
  };
  const tell = (orgId) => sendTo(q('SELECT id FROM users WHERE org_id = ?').all(orgId).map((u) => u.id), { type: 'groups-changed' });
  r.post('/', requireAdmin, (req, res) => {
    const name = str(req.body?.name, { required: true, name: 'Name', max: 80 });
    if (q('SELECT COUNT(*) AS n FROM groups WHERE org_id = ?').get(req.user.org_id).n >= MAX_GROUPS) throw bad(`A company can have up to ${MAX_GROUPS} groups`);
    if (q('SELECT 1 FROM groups WHERE org_id = ? AND lower(name) = lower(?)').get(req.user.org_id, name)) throw bad('There is already a group with that name');
    const id = uid();
    q('INSERT INTO groups (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.org_id, name, str(req.body?.description ?? '', { max: 300 }) || '', now());
    audit(req, 'group.create', { target: name });
    tell(req.user.org_id);
    res.status(201).json(describe(q('SELECT * FROM groups WHERE id = ?').get(id)));
  });
  r.patch('/:id', requireAdmin, (req, res) => {
    const g = load(req);
    const name = req.body?.name !== undefined ? str(req.body.name, { required: true, name: 'Name', max: 80 }) : g.name;
    if (name.toLowerCase() !== g.name.toLowerCase() && q('SELECT 1 FROM groups WHERE org_id = ? AND lower(name) = lower(?)').get(g.org_id, name)) throw bad('There is already a group with that name');
    const description = req.body?.description !== undefined ? str(req.body.description, { max: 300 }) || '' : g.description;
    q('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(name, description, g.id);
    tell(g.org_id);
    res.json(describe(q('SELECT * FROM groups WHERE id = ?').get(g.id)));
  });
  // The members, as a whole list: { user_ids: [...] }.
  r.put('/:id/members', requireAdmin, (req, res) => {
    const g = load(req);
    const ids = Array.isArray(req.body?.user_ids) ? [...new Set(req.body.user_ids.map(String))] : null;
    if (!ids) throw bad('user_ids must be a list');
    const before = new Set(q('SELECT user_id FROM group_members WHERE group_id = ?').all(g.id).map((m) => m.user_id));
    tx(() => {
      for (const id of ids) if (!q('SELECT 1 FROM users WHERE id = ? AND org_id = ?').get(id, g.org_id)) throw bad('Members must be in your company');
      q('DELETE FROM group_members WHERE group_id = ?').run(g.id);
      for (const id of ids) q('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, id);
      syncGroups([g.id]);
    });
    const added = ids.filter((id) => !before.has(id));
    const files = q('SELECT COUNT(*) AS n FROM group_shares WHERE group_id = ?').get(g.id).n;
    bell(added.filter((id) => id !== req.user.id), { kind: 'share', title: `${req.user.name} added you to the group “${g.name}”`,
      body: files ? `${files} shared ${files === 1 ? 'item' : 'items'} in Drive → Shared with me` : null, link: '/drive/shared', actor: req.user.name });
    audit(req, 'group.members', { target: g.name, details: { members: ids.length } });
    sendTo([...new Set([...before, ...ids])], { type: 'files-changed', parent_id: null });
    tell(g.org_id);
    res.json(describe(g));
  });
  r.delete('/:id', requireAdmin, (req, res) => {
    const g = load(req);
    const members = q('SELECT user_id FROM group_members WHERE group_id = ?').all(g.id).map((m) => m.user_id);
    const files = q('SELECT file_id FROM group_shares WHERE group_id = ?').all(g.id).map((x) => x.file_id);
    tx(() => {
      q('DELETE FROM groups WHERE id = ?').run(g.id); // its shares go with it
      for (const f of files) sync(f);
    });
    audit(req, 'group.delete', { target: g.name });
    sendTo(members, { type: 'files-changed', parent_id: null });
    tell(g.org_id);
    res.json({ ok: true });
  });
  return r;
}
