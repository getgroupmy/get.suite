import { SIGNATURE_MODES } from '../mail/companysig.js';
import { MAIL_EMPTY_CHOICES } from '../mail/config.js';
import { IDLE_CHOICES, MAX_HOURS_CHOICES } from '../auth.js';
import { rulesOf, EXPIRY_CHOICES } from '../passwordrules.js';
import { readNets, inNets } from '../netrules.js';
import { normalizeIp } from '../security/guard.js';
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../db.js';
import { uid } from '../util.js';
import { audit } from '../audit.js';
import { q, tx } from '../db.js';
import { str, int, bad, notFound } from '../util.js';
import { requireAdmin, requireSuper } from '../auth.js';
import { createOrg, addDomain, orgStorageUsed, blobsOwnedBy, removeBlobs } from '../tenancy.js';
import { scheduleMailConfig } from '../mail/config.js';
import { collectHealth } from '../health.js';

const domainsOf = (orgId) => q('SELECT name FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId).map((d) => d.name);

function describe(org) {
  return {
    ...org,
    allow_external: !!org.allow_external,
    allow_links: !!org.allow_links,
    meet_guests: org.meet_guests === undefined ? true : !!org.meet_guests,
    allow_publish: org.allow_publish === undefined ? true : !!org.allow_publish,
    allow_api_tokens: !!org.allow_api_tokens,
    require_2fa: !!org.require_2fa,
    password_rules: rulesOf(org.id),
    view_history: org.view_history === undefined ? true : !!org.view_history,
    // People who still have to set up two-step verification (when it's required).
    without_2fa: q(`SELECT COUNT(*) AS n FROM users u WHERE u.org_id = ? AND u.disabled = 0
                    AND NOT EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1)`).get(org.id).n,
    domains: domainsOf(org.id),
    users: q('SELECT COUNT(*) AS n FROM users WHERE org_id = ?').get(org.id).n,
    storage_used: orgStorageUsed(org.id),
    logo: org.logo ? `/api/public/brand/logo/${org.id}?v=${org.logo.slice(0, 8)}` : null,
    logo_mime: undefined,
  };
}

function updateOrg(orgId, body, { asSuper, user }) {
  if (body.name !== undefined) q('UPDATE orgs SET name = ? WHERE id = ?').run(str(body.name, { required: true, name: 'Company name', max: 100 }), orgId);
  if (body.allow_external !== undefined) q('UPDATE orgs SET allow_external = ? WHERE id = ?').run(body.allow_external ? 1 : 0, orgId);
  if (body.allow_publish !== undefined) q('UPDATE orgs SET allow_publish = ? WHERE id = ?').run(body.allow_publish ? 1 : 0, orgId);
  if (body.meet_guests !== undefined) q('UPDATE orgs SET meet_guests = ? WHERE id = ?').run(body.meet_guests ? 1 : 0, orgId);
  if (body.allow_links !== undefined) q('UPDATE orgs SET allow_links = ? WHERE id = ?').run(body.allow_links ? 1 : 0, orgId);
  if (body.allow_api_tokens !== undefined) q('UPDATE orgs SET allow_api_tokens = ? WHERE id = ?').run(body.allow_api_tokens ? 1 : 0, orgId);
  if (body.require_2fa !== undefined) {
    // Requiring it without having it yourself would lock you out of these settings at once.
    const own = q('SELECT 1 FROM two_factor WHERE user_id = ? AND enabled = 1').get(user.id);
    if (body.require_2fa && user.org_id === orgId && !own) throw bad('Turn on two-step verification for your own account first (Settings), then require it for everyone');
    q('UPDATE orgs SET require_2fa = ? WHERE id = ?').run(body.require_2fa ? 1 : 0, orgId);
  }
  if (body.trash_days !== undefined) {
    const d = Number(body.trash_days);
    if (!Number.isInteger(d) || d < 0 || d > 3650) throw bad('Days in the trash must be a whole number from 0 (never empty) to 3650');
    q('UPDATE orgs SET trash_days = ? WHERE id = ?').run(d, orgId);
  }
  if (body.allowed_nets !== undefined) {
    let nets;
    try { nets = readNets(body.allowed_nets); } catch (e) { throw bad(e.message); }
    // Don't let an admin shut themselves out: where they are now must be in the list.
    if (nets.length && !user.is_super && user.org_id === orgId && !inNets(user.ip, nets)) throw bad(`Your own address now (${user.ip}) isn't in the list: add it, or you'd be signed out at once`);
    q('UPDATE orgs SET allowed_nets = ? WHERE id = ?').run(nets.length ? nets.join('\n') : null, orgId);
  }
  // Password rules: { min, mix, symbol, common, max_days }; they apply to passwords chosen from now on
  // (and an expiry, to everyone's current one).
  if (body.password_rules !== undefined) {
    const pr = body.password_rules || {};
    const min = Number(pr.min ?? 8), days = Number(pr.max_days ?? 0);
    if (!Number.isInteger(min) || min < 8 || min > 64) throw bad('The minimum length must be from 8 to 64 characters');
    if (!EXPIRY_CHOICES.includes(days)) throw bad(`Passwords can expire after ${EXPIRY_CHOICES.filter(Boolean).join(', ')} days, or never`);
    q('UPDATE orgs SET pw_min = ?, pw_mix = ?, pw_symbol = ?, pw_common = ?, pw_max_days = ? WHERE id = ?').run(min, pr.mix ? 1 : 0, pr.symbol ? 1 : 0, pr.common ? 1 : 0, days, orgId);
  }
  for (const key of ['mail_trash_days', 'mail_junk_days']) {
    if (body[key] === undefined) continue;
    const d = Number(body[key]);
    if (!MAIL_EMPTY_CHOICES.includes(d)) throw bad('Choose after how many days, or never');
    q(`UPDATE orgs SET ${key} = ? WHERE id = ?`).run(d, orgId);
    scheduleMailConfig();
  }
  if (body.session_idle_min !== undefined) {
    const m = Number(body.session_idle_min);
    if (!IDLE_CHOICES.includes(m)) throw bad('Choose how long without activity before signing out');
    q('UPDATE orgs SET session_idle_min = ? WHERE id = ?').run(m, orgId);
  }
  if (body.session_max_hours !== undefined) {
    const h = Number(body.session_max_hours);
    if (!MAX_HOURS_CHOICES.includes(h)) throw bad('Choose the longest a sign-in lasts');
    q('UPDATE orgs SET session_max_hours = ? WHERE id = ?').run(h, orgId);
  }
  if (body.chat_days !== undefined) {
    const d = Number(body.chat_days);
    if (![0, 30, 90, 365, 1825].includes(d)) throw bad('Keep chat messages forever, or for 30 days, 90 days, a year or 5 years');
    q('UPDATE orgs SET chat_days = ? WHERE id = ?').run(d, orgId);
  }
  // The company signature: a template ({name}, {job_title}…) and whether it's a default or for everyone.
  if (body.signature_template !== undefined) {
    const t = String(body.signature_template ?? '');
    if (t.length > 20000) throw bad('The signature is too long');
    q('UPDATE orgs SET signature_template = ? WHERE id = ?').run(t.trim() ? t : null, orgId);
  }
  if (body.signature_mode !== undefined) {
    if (!SIGNATURE_MODES.includes(body.signature_mode)) throw bad('signature_mode must be off, default or always');
    q('UPDATE orgs SET signature_mode = ? WHERE id = ?').run(body.signature_mode, orgId);
  }
  if (body.view_history !== undefined) q('UPDATE orgs SET view_history = ? WHERE id = ?').run(body.view_history ? 1 : 0, orgId); // "who has seen it" in Drive
  if (body.accent !== undefined) {
    if (body.accent !== null && !/^#[0-9a-f]{6}$/i.test(String(body.accent))) throw bad('Pick a colour like #1a73e8');
    q('UPDATE orgs SET accent = ? WHERE id = ?').run(body.accent ? String(body.accent).toLowerCase() : null, orgId);
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
    res.json({ ...describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)), your_ip: normalizeIp(req.ip) });
  });
  r.patch('/current', requireAdmin, (req, res) => {
    updateOrg(req.user.org_id, req.body, { asSuper: req.user.is_super, user: { ...req.user, ip: normalizeIp(req.ip) } });
    audit(req, 'company.update', { org: req.user.org_id, details: Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => !/password/i.test(k))) });
    res.json(describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)));
  });

  // Branding: the company's logo (a PNG, JPEG or WebP picture up to 1 MB; no SVG, which can carry scripts).
  r.put('/current/logo', requireAdmin, express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
      : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
      : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw bad('The logo must be a PNG, JPEG or WebP picture');
    const old = q('SELECT logo FROM orgs WHERE id = ?').get(req.user.org_id)?.logo;
    const name = `logo-${uid()}`;
    fs.writeFileSync(path.join(FILES_DIR, name), buf);
    q('UPDATE orgs SET logo = ?, logo_mime = ? WHERE id = ?').run(name, mime, req.user.org_id);
    if (old) fs.rm(path.join(FILES_DIR, old), { force: true }, () => {});
    audit(req, 'company.update', { org: req.user.org_id, details: { logo: 'changed' } });
    res.json(describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)));
  });
  r.delete('/current/logo', requireAdmin, (req, res) => {
    const old = q('SELECT logo FROM orgs WHERE id = ?').get(req.user.org_id)?.logo;
    q('UPDATE orgs SET logo = NULL, logo_mime = NULL WHERE id = ?').run(req.user.org_id);
    if (old) fs.rm(path.join(FILES_DIR, old), { force: true }, () => {});
    res.json(describe(q('SELECT * FROM orgs WHERE id = ?').get(req.user.org_id)));
  });

  // Storage: the company's total (and quota), how much each person uses (files, earlier versions,
  // the trash), and the largest files. The platform owner may ask about any company (?org_id=).
  r.get('/current/storage', requireAdmin, (req, res) => {
    const orgId = req.query.org_id && req.user.is_super ? String(req.query.org_id) : req.user.org_id;
    const org = q('SELECT * FROM orgs WHERE id = ?').get(orgId);
    if (!org) throw notFound('Company not found');
    const people = q(`SELECT u.id, u.name, u.username,
        COALESCE((SELECT SUM(f.size) FROM files f WHERE f.owner_id = u.id AND f.trashed = 0), 0) AS files,
        COALESCE((SELECT SUM(f.size) FROM files f WHERE f.owner_id = u.id AND f.trashed = 1), 0) AS trash,
        COALESCE((SELECT SUM(v.size) FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.owner_id = u.id), 0) AS versions,
        (SELECT COUNT(*) FROM files f WHERE f.owner_id = u.id AND f.kind != 'folder') AS count
      FROM users u WHERE u.org_id = ? ORDER BY u.name COLLATE NOCASE`).all(orgId)
      .map((p) => ({ ...p, total: p.files + p.trash + p.versions })).sort((a, b) => b.total - a.total);
    const largest = q(`SELECT f.id, f.name, f.kind, f.mime, f.size, f.trashed, f.updated_at, u.name AS owner_name,
        COALESCE((SELECT SUM(v.size) FROM file_versions v WHERE v.file_id = f.id), 0) AS versions_size
      FROM files f JOIN users u ON u.id = f.owner_id WHERE u.org_id = ? AND f.kind != 'folder' ORDER BY f.size + versions_size DESC LIMIT 25`).all(orgId)
      .map((f) => ({ ...f, trashed: !!f.trashed }));
    res.json({ used: orgStorageUsed(orgId), quota_mb: org.quota_mb || null, people, largest });
  });

  // ---- platform owner: all companies ----
  r.use(requireSuper);
  // System health: disk, snapshots, mail server and certificate, sizes (health.js).
  r.get('/system/health', async (req, res) => res.json(await collectHealth()));

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
    audit(req, 'company.update', { org: req.params.id, details: Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => !/password/i.test(k))) });
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
