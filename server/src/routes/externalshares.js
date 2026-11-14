// Admin → Shared outside: the company's files and folders shared with people at other companies
// (working across companies), who shared what with whom, and a way to stop one or all with a company.
import { Router } from 'express';
import { q } from '../db.js';
import { notFound, bad } from '../util.js';
import { requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';

/** Every share from someone in `orgId` to someone outside it that still works, newest file first. */
export function externalShares(orgId, at = Date.now()) {
  return q(`SELECT s.file_id, s.user_id, s.role, s.expires_at, f.name AS file_name, f.kind, f.trashed, f.updated_at,
                   o.id AS owner_id, o.name AS owner_name, o.username AS owner_email,
                   w.name AS with_name, w.username AS with_email, wo.id AS with_org_id, wo.name AS with_company
            FROM shares s JOIN files f ON f.id = s.file_id JOIN users o ON o.id = f.owner_id
                 JOIN users w ON w.id = s.user_id LEFT JOIN orgs wo ON wo.id = w.org_id
            WHERE o.org_id = ? AND w.org_id IS NOT o.org_id AND (s.expires_at IS NULL OR s.expires_at > ?)
            ORDER BY wo.name COLLATE NOCASE, f.name COLLATE NOCASE LIMIT 5000`).all(orgId, at)
    .map((r) => ({ ...r, trashed: !!r.trashed }));
}

/** Take shares away (rows from externalShares), telling each owner what went. */
function stop(req, rows) {
  const byOwner = new Map();
  for (const r of rows) {
    q('DELETE FROM shares WHERE file_id = ? AND user_id = ?').run(r.file_id, r.user_id);
    if (!byOwner.has(r.owner_id)) byOwner.set(r.owner_id, []);
    byOwner.get(r.owner_id).push(r);
    sendTo([r.user_id], { type: 'files-changed' });
  }
  for (const [owner, list] of byOwner) {
    if (owner === req.user.id) continue;
    const names = [...new Set(list.map((r) => r.file_name))];
    bell([owner], { kind: 'share', title: `An admin stopped sharing ${names.length === 1 ? `“${names[0]}”` : `${names.length} of your files`} outside the company`,
      body: `With ${[...new Set(list.map((r) => r.with_email))].slice(0, 5).join(', ')}.`, link: '/drive', actor: req.user.name });
  }
}

export function externalShareRoutes() {
  const r = Router();
  r.use(requireAdmin);
  r.get('/', (req, res) => {
    const items = externalShares(req.user.org_id);
    const companies = new Map();
    for (const x of items) {
      const c = companies.get(x.with_org_id) || { id: x.with_org_id, name: x.with_company || 'Another company', people: new Set(), items: 0 };
      c.people.add(x.with_email); c.items++;
      companies.set(x.with_org_id, c);
    }
    res.json({ items, companies: [...companies.values()].map((c) => ({ ...c, people: c.people.size })).sort((a, b) => b.items - a.items) });
  });
  // One share: DELETE /:fileId/:userId.
  r.delete('/:fileId/:userId', (req, res) => {
    const row = externalShares(req.user.org_id).find((x) => x.file_id === req.params.fileId && x.user_id === req.params.userId);
    if (!row) throw notFound('That share is gone already');
    stop(req, [row]);
    audit(req, 'file.share', { target: row.file_name, details: { removed: row.with_email, by_admin: true } });
    res.json({ stopped: 1 });
  });
  // Everything shared with one company's people: { org_id }.
  r.post('/stop-company', (req, res) => {
    const orgId = String(req.body?.org_id || '');
    if (!orgId) throw bad('Which company?');
    const rows = externalShares(req.user.org_id).filter((x) => x.with_org_id === orgId);
    if (!rows.length) throw notFound('Nothing is shared with that company');
    stop(req, rows);
    audit(req, 'file.share', { target: rows[0].with_company || 'Another company', details: { removed: rows.length, by_admin: true, company: true } });
    res.json({ stopped: rows.length });
  });
  return r;
}
