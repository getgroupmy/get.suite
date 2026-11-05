import { Router } from 'express';
import { q, tx } from '../db.js';
import { str, int, bad, notFound } from '../util.js';
import { requireAdmin, requireSuper } from '../auth.js';
import { createOrg, addDomain, orgStorageUsed, blobsOwnedBy, removeBlobs } from '../tenancy.js';
import { scheduleMailConfig } from '../mail/config.js';

const domainsOf = (orgId) => q('SELECT name FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId).map((d) => d.name);

function describe(org) {
  return {
    ...org,
    allow_external: !!org.allow_external,
    require_2fa: !!org.require_2fa,
    // People who still have to set up two-step verification (when it's required).
    without_2fa: q(`SELECT COUNT(*) AS n FROM users u WHERE u.org_id = ? AND u.disabled = 0
                    AND NOT EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1)`).get(org.id).n,
    domains: domainsOf(org.id),
    users: q('SELECT COUNT(*) AS n FROM users WHERE org_id = ?').get(org.id).n,
    storage_used: orgStorageUsed(org.id),
  };
}

function updateOrg(orgId, body, { asSuper, user }) {
  if (body.name !== undefined) q('UPDATE orgs SET name = ? WHERE id = ?').run(str(body.name, { required: true, name: 'Company name', max: 100 }), orgId);
  if (body.allow_external !== undefined) q('UPDATE orgs SET allow_external = ? WHERE id = ?').run(body.allow_external ? 1 : 0, orgId);
  if (body.require_2fa !== undefined) {
    // Requiring it without having it yourself would lock you out of these settings at once.
    const own = q('SELECT 1 FROM two_factor WHERE user_id = ? AND enabled = 1').get(user.id);
    if (body.require_2fa && user.org_id === orgId && !own) throw bad('Turn on two-step verification for your own account first (Settings), then require it for everyone');
    q('UPDATE orgs SET require_2fa = ? WHERE id = ?').run(body.require_2fa ? 1 : 0, orgId);
  }
  if (body.quota_mb !== undefined) {
    if (!asSuper) throw bad('Only the platform owner can change storage quotas');
    const mb = int(body.quota_mb, 'quota_mb');
    if (mb < 0) throw bad('Quota cannot be negative');
    q('UPDATE orgs SET quota_mb = ? WHERE id = ?').run(mb, orgId);
  }
}

export default function orgRoutes() {
  const r = Router();

  // ---- company admins: their own company ----
  r.get('/current', requireAdmin, (req, res) => {
    res.json(describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)));
  });
  r.patch('/current', requireAdmin, (req, res) => {
    updateOrg(req.user.org_id, req.body, { asSuper: req.user.is_super, user: req.user });
    res.json(describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)));
  });

  // ---- platform owner: all companies ----
  r.use(requireSuper);

  r.get('/', (req, res) => {
    res.json(q('SELECT * FROM orgs ORDER BY name COLLATE NOCASE').all().map(describe));
  });

  r.post('/', (req, res) => {
    const b = req.body;
    const created = tx(() => createOrg({ name: b.name, domain: b.domain, adminName: b.admin_name, adminLocal: b.admin_local, adminPassword: b.admin_password }));
    res.status(201).json(created);
  });

  const loadOrg = (id) => { const o = q('SELECT * FROM orgs WHERE id = ?').get(id); if (!o) throw notFound('Company not found'); return o; };

  r.patch('/:id', (req, res) => {
    loadOrg(req.params.id);
    updateOrg(req.params.id, req.body, { asSuper: true, user: req.user });
    res.json(describe(loadOrg(req.params.id)));
  });

  r.post('/:id/domains', (req, res) => {
    loadOrg(req.params.id);
    addDomain(req.params.id, req.body.name);
    scheduleMailConfig();
    res.status(201).json(describe(loadOrg(req.params.id)));
  });

  r.delete('/:id/domains/:name', (req, res) => {
    const org = loadOrg(req.params.id);
    const name = req.params.name.toLowerCase();
    if (!q('SELECT 1 FROM domains WHERE name = ? AND org_id = ?').get(name, org.id)) throw notFound('Domain not found');
    if (domainsOf(org.id).length === 1) throw bad('A company needs at least one domain');
    const inUse = q("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND username LIKE '%@' || ?").get(org.id, name).n;
    if (inUse) throw bad(`${inUse} user(s) still have an address on ${name}`);
    if (q("SELECT COUNT(*) AS n FROM aliases WHERE org_id = ? AND address LIKE '%@' || ?").get(org.id, name).n) throw bad(`Aliases still use ${name}`);
    q('DELETE FROM domains WHERE name = ?').run(name);
    scheduleMailConfig();
    res.json(describe(org));
  });

  // Delete a company with all its users, files, calendars and chat.
  r.delete('/:id', (req, res) => {
    const org = loadOrg(req.params.id);
    if (org.id === req.user.org_id) throw bad('You cannot delete your own company');
    const blobs = tx(() => {
      const list = blobsOwnedBy('SELECT id FROM users WHERE org_id = ?', org.id);
      q('DELETE FROM orgs WHERE id = ?').run(org.id);
      return list;
    });
    removeBlobs(blobs);
    scheduleMailConfig();
    res.json({ ok: true });
  });

  return r;
}
