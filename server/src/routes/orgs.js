import { phishingFor, setHandled, blockValue, blockedFor, addBlock, removeBlock } from '../phishing.js';
import { sweepInboxes } from '../mail/sweep.js';
import { checkup, remindRecovery } from '../checkup.js';
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
import { str, int, bad, notFound, HttpError } from '../util.js';
import { requireAdmin, requireSuper } from '../auth.js';
import { createOrg, addDomain, orgStorageUsed, blobsOwnedBy, removeBlobs } from '../tenancy.js';
import { scheduleMailConfig } from '../mail/config.js';
import { companyMail } from '../mail/storage.js';
import { collectHealth } from '../health.js';
import { roleFor, audienceFor, subtreeIds } from '../access.js';
import { notify as bell } from '../notifications.js';
import { backupDatabase, listBackups, backupPath } from '../backup.js';
import { requestRestore } from '../restore.js';
import { checkBlobs, removeUnused } from '../blobcheck.js';
import { DATA_DIR } from '../db.js';
import { readQueue, requestQueueAction, MAIL_STATUS_DIR } from '../mail/queue.js';
import { mailEnabled } from '../mail/config.js';
import '../mail/external.js'; // orgs.ask_outside

const domainsOf = (orgId) => q('SELECT name FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId).map((d) => d.name);

function describe(org) {
  return {
    ...org,
    allow_external: !!org.allow_external,
    allow_links: !!org.allow_links,
    link_max_days: org.link_max_days || null,
    link_password: !!org.link_password,
    meet_guests: org.meet_guests === undefined ? true : !!org.meet_guests,
    allow_publish: org.allow_publish === undefined ? true : !!org.allow_publish,
    allow_api_tokens: !!org.allow_api_tokens,
    require_2fa: !!org.require_2fa,
    password_rules: rulesOf(org.id),
    view_history: org.view_history === undefined ? true : !!org.view_history,
    push_private: !!org.push_private,
    allow_forwarding: org.allow_forwarding === undefined ? true : !!org.allow_forwarding,
    ask_outside: !!org.ask_outside,
    mark_external: !!org.mark_external,
    // People who still have to set up two-step verification (when it's required).
    without_2fa: q(`SELECT COUNT(*) AS n FROM users u WHERE u.org_id = ? AND u.disabled = 0
                    AND NOT EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1)
                    AND NOT EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id)`).get(org.id).n,
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
  // Rules for new and changed links (existing ones are left as they are).
  if (body.link_max_days !== undefined) {
    const d = body.link_max_days === null ? null : Number(body.link_max_days);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) throw bad('Links can be limited to between 1 and 365 days');
    q('UPDATE orgs SET link_max_days = ? WHERE id = ?').run(d, orgId);
  }
  if (body.link_password !== undefined) q('UPDATE orgs SET link_password = ? WHERE id = ?').run(body.link_password ? 1 : 0, orgId);
  if (body.allow_api_tokens !== undefined) q('UPDATE orgs SET allow_api_tokens = ? WHERE id = ?').run(body.allow_api_tokens ? 1 : 0, orgId);
  if (body.allow_forwarding !== undefined) {
    q('UPDATE orgs SET allow_forwarding = ? WHERE id = ?').run(body.allow_forwarding ? 1 : 0, orgId);
    scheduleMailConfig(); // forwarding (and filters' copies) to outside addresses stops, or starts again
  }
  if (body.ask_outside !== undefined) q('UPDATE orgs SET ask_outside = ? WHERE id = ?').run(body.ask_outside ? 1 : 0, orgId);
  if (body.mark_external !== undefined) q('UPDATE orgs SET mark_external = ? WHERE id = ?').run(body.mark_external ? 1 : 0, orgId);
  if (body.push_private !== undefined) q('UPDATE orgs SET push_private = ? WHERE id = ?').run(body.push_private ? 1 : 0, orgId);
  if (body.require_2fa !== undefined) {
    // Requiring it without having it yourself would lock you out of these settings at once.
    const own = q('SELECT 1 FROM two_factor WHERE user_id = ? AND enabled = 1').get(user.id) || q('SELECT 1 FROM passkeys WHERE user_id = ?').get(user.id);
    if (body.require_2fa && user.org_id === orgId && !own) throw bad('Turn on two-step verification for your own account first (or add a passkey, in Settings), then require it for everyone');
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

  // Mailboxes: how much each person's mail takes, against their mailbox size limit (from the mail server).
  r.get('/current/mail-storage', requireAdmin, async (req, res) => {
    const orgId = req.query.org_id && req.user.is_super ? String(req.query.org_id) : req.user.org_id;
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) throw notFound('Company not found');
    if (!mailEnabled()) throw new HttpError(503, 'Email is not set up on this server');
    res.json(await companyMail(orgId, { fresh: req.query.fresh === '1' }));
  });

  // Storage: the company's total (and quota), how much each person uses (files, earlier versions,
  // the trash), and the largest files. The platform owner may ask about any company (?org_id=).
  // Security checkup (Admin → Security checkup): the company's open security points.
  r.post('/current/checkup/remind-recovery', requireAdmin, (req, res) => {
    let n;
    try { n = remindRecovery(req.user.org_id); } catch (e) { throw new HttpError(e.status || 400, e.message); }
    audit(req, 'checkup.remind', { target: `${n} people`, details: { what: 'recovery email' } });
    res.json({ reminded: n });
  });
  r.get('/current/checkup', requireAdmin, async (req, res) => res.json({ items: await checkup(req.user.org_id) }));
  // Phishing reports from people in the company (Admin → Phishing).
  r.get('/current/phishing', requireAdmin, (req, res) => res.json(phishingFor(req.user.org_id)));
  r.post('/current/phishing/handled', requireAdmin, (req, res) => {
    setHandled(req.user.org_id, req.body?.sender, req.user.id, req.body?.handled !== false);
    res.json(phishingFor(req.user.org_id));
  });
  // Senders blocked for everyone in the company: their mail goes to Junk (marked read) for all.
  r.get('/current/blocked', requireAdmin, (req, res) => res.json(blockedFor(req.user.org_id)));
  r.post('/current/blocked', requireAdmin, (req, res) => {
    const value = blockValue(req.body?.value, domainsOf(req.user.org_id));
    addBlock(req.user.org_id, value, req.user.id);
    scheduleMailConfig();
    audit(req, 'mail.blocked', { target: value });
    res.status(201).json({ blocked: blockedFor(req.user.org_id), reports: phishingFor(req.user.org_id) });
  });
  // Take mail from a sender (or domain) out of everyone's Inbox in the company, to Junk (marked read).
  r.post('/current/phishing/sweep', requireAdmin, async (req, res) => {
    if (!mailEnabled()) throw bad('Email is not set up on this server');
    const value = blockValue(req.body?.value, domainsOf(req.user.org_id));
    const people = q('SELECT id, username, org_id FROM users WHERE org_id = ? AND disabled = 0').all(req.user.org_id);
    const r = await sweepInboxes(people, value);
    audit(req, 'mail.swept', { target: value, details: { people: r.people, messages: r.messages, failed: r.failed.length } });
    res.json(r);
  });
  r.delete('/current/blocked/:value', requireAdmin, (req, res) => {
    removeBlock(req.user.org_id, req.params.value);
    scheduleMailConfig();
    audit(req, 'mail.unblocked', { target: String(req.params.value).toLowerCase() });
    res.json({ blocked: blockedFor(req.user.org_id) });
  });
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

  // Shared drives in the company (admins): who owns each, how many are in it, how big it is, and
  // the admin's own access. An admin can add themselves as an editor, to look after a drive whose
  // people have moved on; its owner is told.
  const companyOf = (req) => (req.query.org_id && req.user.is_super ? String(req.query.org_id) : req.user.org_id);
  r.get('/current/drives', requireAdmin, (req, res) => {
    const drives = q(`SELECT f.id, f.name, f.owner_id, f.created_at, u.name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id
                      WHERE f.is_drive = 1 AND f.trashed = 0 AND u.org_id = ? ORDER BY f.name COLLATE NOCASE`).all(companyOf(req));
    res.json(drives.map((d) => {
      const ids = JSON.stringify(subtreeIds(d.id).filter((id) => id !== d.id));
      const c = q("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS size FROM files WHERE trashed = 0 AND kind != 'folder' AND id IN (SELECT value FROM json_each(?))").get(ids);
      return { ...d, members: audienceFor(d.id).length, items: c.n, size: c.size, my_role: roleFor(d.id, req.user.id) };
    }));
  });
  r.post('/current/drives/:id/join', requireAdmin, (req, res) => {
    const d = q('SELECT f.id, f.name, f.owner_id, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ? AND f.is_drive = 1').get(req.params.id);
    if (!d || (d.org_id !== req.user.org_id && !req.user.is_super)) throw notFound('Shared drive not found');
    if (d.owner_id === req.user.id) throw bad('You own this shared drive');
    q(`INSERT INTO shares (file_id, user_id, role, direct_role) VALUES (?, ?, 'editor', 'editor')
       ON CONFLICT(file_id, user_id) DO UPDATE SET role = 'editor', direct_role = 'editor', expires_at = NULL`).run(d.id, req.user.id);
    audit(req, 'drive.join', { org: d.org_id, target: d.name });
    bell([d.owner_id], { kind: 'share', title: `${req.user.name} (an admin) added themselves to the shared drive “${d.name}”`, body: 'They can edit it and manage its members', link: `/drive/folder/${d.id}`, actor: req.user.name });
    res.json({ ok: true, role: roleFor(d.id, req.user.id) });
  });

  // ---- platform owner: all companies ----
  r.use(requireSuper);
  // System health: disk, snapshots, mail server and certificate, sizes (health.js).
  r.get('/system/health', async (req, res) => res.json(await collectHealth()));
  // Database snapshots: the ones kept, one taken now (today's is replaced), and downloading one.
  // The outgoing mail queue: what's waiting, and asking the mail server to retry or delete it.
  r.get('/system/mail-queue', (req, res) => {
    const qd = mailEnabled() ? readQueue() : null;
    res.json(qd ? { available: true, ...qd } : { available: false, reason: !mailEnabled() ? 'no-mail' : !MAIL_STATUS_DIR ? 'not-set-up' : 'no-report' });
  });
  r.post('/system/mail-queue', (req, res) => {
    if (!mailEnabled() || !MAIL_STATUS_DIR) throw bad('The mail queue isn’t available on this server');
    const op = str(req.body?.op), id = req.body?.id ? str(req.body.id) : null;
    let seq;
    try { seq = requestQueueAction(op, id); } catch (e) { throw bad(e.message); }
    if (op === 'delete') audit(req, 'mail-queue.delete', { target: id });
    res.json({ seq });
  });
  r.get('/system/backups', (req, res) => res.json(listBackups()));
  r.post('/system/backups', (req, res) => {
    const name = path.basename(backupDatabase());
    audit(req, 'backup.create', { target: name });
    res.json(listBackups());
  });
  // Uploaded files against the database: unused ones (removable) and missing ones (blobcheck.js).
  r.get('/system/files-check', (req, res) => { const { unused: { names, ...unused }, ...rest } = checkBlobs(); res.json({ ...rest, unused }); });
  r.post('/system/files-check/clean', (req, res) => {
    const done = removeUnused();
    audit(req, 'files.clean', { details: done });
    res.json(done);
  });
  // Put a snapshot back: the app stops, Docker starts it again, and the snapshot is in place before
  // the database opens (restore.js). { confirm: <the snapshot's name> }, so it's never by accident.
  r.post('/system/backups/:name/restore', (req, res) => {
    const name = req.params.name;
    if (!backupPath(name)) throw notFound('No such snapshot');
    if (req.body?.confirm !== name) throw bad('Confirm with the snapshot’s name');
    requestRestore(DATA_DIR, name, { id: req.user.id, name: req.user.name });
    audit(req, 'backup.restore', { target: name }); // kept in the copy of the database as it was
    const restart = process.env.NW_RESTORE_EXIT !== '0';
    res.on('finish', () => { if (restart) setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300); });
    res.json({ ok: true, restarting: restart });
  });
  r.get('/system/backups/:name', (req, res) => {
    const f = backupPath(req.params.name);
    if (!f) throw notFound('No such snapshot');
    audit(req, 'backup.download', { target: req.params.name });
    res.download(f, req.params.name);
  });

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
