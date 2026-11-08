import { disable as disableTwoFactor } from '../twofactor.js';
import { audit } from '../audit.js';
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import { orgMemberIds } from '../tenancy.js';
import { q, tx } from '../db.js';
import { str, bad, notFound, forbidden } from '../util.js';
import { requireAdmin, validatePassword, hashPassword, newUserRow } from '../auth.js';
import { validAddress, canReach, blobsOwnedBy, removeBlobs, mailHomeOf, retireMailHome } from '../tenancy.js';
import { uid } from '../util.js';
import { planImport, readablePassword, usersCsv } from '../userimport.js';
import { sendTo } from '../hub.js';
import { hoursOf, setHours, readHours, hoursText } from '../workhours.js';
import { insertFile, uniqueName } from './files.js';
import { focusUntil, calendarStatus } from './calendar.js';

/** A status as shown, or null once it has cleared. */
export function statusOf(row, at = Date.now()) {
  if (!row || (!row.status_emoji && !row.status_text) || (row.status_until && row.status_until <= at)) return null;
  return { emoji: row.status_emoji || null, text: row.status_text || null, until: row.status_until || null };
}
/** Colleagues (and the person's other tabs) see a status change at once. */
const statusChanged = (user) => sendTo(q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(user.org_id).map((u) => u.id), { type: 'status-changed', user_id: user.id });
import { forgetConnection } from '../mail/imap.js';
import { setMailPassword, scheduleMailConfig } from '../mail/config.js';

/** Which company an admin request acts on: their own, or any (platform owner, via ?org_id=). */
function targetOrg(req) {
  const id = req.query.org_id || req.body?.org_id;
  if (id && id !== req.user.org_id) {
    if (!req.user.is_super) throw forbidden('You can only manage your own company');
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw notFound('Company not found');
    return id;
  }
  return req.user.org_id;
}

function loadManagedUser(req) {
  const u = q('SELECT id, org_id, is_super, username, mail_home FROM users WHERE id = ?').get(req.params.id);
  if (!u || (u.org_id !== req.user.org_id && !req.user.is_super)) throw notFound();
  return u;
}

/**
 * Give someone a new address. Their mailbox, files, calendar and chats stay theirs (all linked by
 * account, not address); aliases, catch-alls and signatures follow the new address. The old address
 * can stay as an alias, so mail sent to it still arrives (and they can still send as it).
 */
function renameAddress(u, address, keepOld) {
  const old = u.username;
  tx(() => {
    q('UPDATE users SET username = ?, email = ?, mail_home = ? WHERE id = ?').run(address, address, mailHomeOf(u), u.id);
    for (const a of q('SELECT id, targets FROM aliases WHERE org_id = ?').all(u.org_id)) {
      const targets = a.targets.split(',').map((t) => t.trim());
      if (targets.some((t) => t.toLowerCase() === old)) {
        q('UPDATE aliases SET targets = ? WHERE id = ?').run([...new Set(targets.map((t) => (t.toLowerCase() === old ? address : t)))].join(', '), a.id);
      }
    }
    q('UPDATE domains SET catchall = ? WHERE catchall = ?').run(address, old);
    q('UPDATE identity_signatures SET address = ? WHERE user_id = ? AND address = ?').run(address, u.id, old);
    if (keepOld) q('INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), u.org_id, old, address, Date.now());
  });
  forgetConnection(u.id); // webmail reconnects under the new address
  u.username = address;
}

// Profile photos: a small picture instead of your initials, for your colleagues to see. The browser
// makes it a square JPEG first; it's kept as DATA_DIR/photos/<user id>.jpg, versioned for caching.
const PHOTOS = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTOS, { recursive: true });
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'photo_v')) q('ALTER TABLE users ADD COLUMN photo_v INTEGER').run();
const photoFile = (id) => path.join(PHOTOS, `${id.replace(/[^\w-]/g, '')}.jpg`);
const isPicture = (b) => b.length > 8 && ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'));
const MAX_PHOTO = 1024 * 1024;

export default function userRoutes() {
  const r = Router();

  // Everyone: your own company's directory (for sharing, chat, contacts).
  r.get('/directory', (req, res) => {
    const now = Date.now();
    res.json(q('SELECT id, username, name, status_emoji, status_text, status_until, paused_until FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name')
      .all(req.user.org_id).map(({ status_emoji, status_text, status_until, paused_until, ...u }) => ({ ...u, status: statusOf({ status_emoji, status_text, status_until }) || calendarStatus(u.id), paused_until: paused_until > now ? paused_until : null })));
  });

  // Photos: who has one (your company), yours to set or remove, and each one's picture.
  r.get('/photos', (req, res) => {
    res.json(q('SELECT id, username AS email, photo_v AS v FROM users WHERE org_id = ? AND photo_v IS NOT NULL AND disabled = 0').all(req.user.org_id));
  });
  r.put('/me/photo', express.raw({ type: () => true, limit: MAX_PHOTO }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isPicture(body)) throw bad('Choose a JPEG, PNG or WebP picture');
    fs.writeFileSync(photoFile(req.user.id), body);
    const v = Date.now();
    q('UPDATE users SET photo_v = ? WHERE id = ?').run(v, req.user.id);
    sendTo(orgMemberIds(req.user.org_id), { type: 'photos-changed' });
    res.json({ v });
  });
  r.delete('/me/photo', (req, res) => {
    fs.rmSync(photoFile(req.user.id), { force: true });
    q('UPDATE users SET photo_v = NULL WHERE id = ?').run(req.user.id);
    sendTo(orgMemberIds(req.user.org_id), { type: 'photos-changed' });
    res.json({ ok: true });
  });
  r.get('/:id/photo', (req, res) => {
    const u = q('SELECT id, org_id, photo_v FROM users WHERE id = ?').get(String(req.params.id));
    if (!u || !u.photo_v || (u.org_id !== req.user.org_id && !canReach(req.user, u.id))) throw notFound();
    const data = fs.readFileSync(photoFile(u.id));
    const type = data[0] === 0xff ? 'image/jpeg' : data[0] === 0x89 ? 'image/png' : 'image/webp';
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // the address carries ?v=
    res.send(data);
  });

  // Your working hours (Find a time keeps to them); null puts back the usual Monday–Friday, 9–5.
  r.get('/me/work-hours', (req, res) => {
    const h = hoursOf(req.user.id, String(req.query.tz || 'UTC'));
    res.json({ ...h, text: hoursText(h) });
  });
  r.put('/me/work-hours', (req, res) => {
    setHours(req.user.id, req.body.hours === null ? null : readHours(req.body.hours));
    const h = hoursOf(req.user.id, String(req.body.hours?.tz || 'UTC'));
    res.json({ ...h, text: hoursText(h) });
  });

  // A second time zone for Calendar: { tz: 'Asia/Tokyo' } or { tz: null }.
  r.put('/me/second-tz', (req, res) => {
    const tz = req.body?.tz ? String(req.body.tz).slice(0, 64) : null;
    if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw bad('Unknown time zone'); } }
    q('UPDATE users SET second_tz = ? WHERE id = ?').run(tz, req.user.id);
    res.json({ second_tz: tz });
  });

  // Where Workspace opens for you: { page: 'drive' | 'home' }.
  r.put('/me/start-page', (req, res) => {
    const page = req.body?.page === 'home' ? 'home' : req.body?.page === 'drive' ? 'drive' : null;
    if (!page) throw bad('page must be drive or home');
    q('UPDATE users SET start_page = ? WHERE id = ?').run(page === 'drive' ? null : page, req.user.id);
    res.json({ start_page: page });
  });

  // Your status: what colleagues see next to your name, until it clears by itself.
  // Pause notifications ("do not disturb") until a time, or stop pausing (until: null).
  r.get('/me/pause', (req, res) => {
    const until = q('SELECT paused_until FROM users WHERE id = ?').get(req.user.id).paused_until;
    const focus = focusUntil(req.user.id); // in focus time: paused until it ends
    const best = Math.max(until > Date.now() ? until : 0, focus || 0);
    res.json({ paused_until: best || null, focus: !!focus && focus >= (until || 0) });
  });
  r.put('/me/pause', (req, res) => {
    let until = req.body.until == null ? null : Number(req.body.until);
    if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw bad('Pick a time in the future');
    if (until !== null && until > Date.now() + 31 * 864e5) throw bad('Notifications can be paused for up to a month');
    q('UPDATE users SET paused_until = ? WHERE id = ?').run(until, req.user.id);
    statusChanged(req.user); // colleagues see 🔕; your other tabs pause too
    res.json({ paused_until: until });
  });

  r.get('/me/status', (req, res) => {
    res.json({ status: statusOf(q('SELECT status_emoji, status_text, status_until FROM users WHERE id = ?').get(req.user.id)) });
  });
  r.put('/me/status', (req, res) => {
    const text = str(req.body.text, { max: 100, name: 'Status' }) || null;
    const emoji = String(req.body.emoji || '').trim() || null;
    if (emoji && (emoji.length > 16 || /[\s<>]/.test(emoji))) throw bad('Choose an emoji');
    if (!text && !emoji) throw bad('Type a status or choose an emoji');
    let until = req.body.until == null ? null : Number(req.body.until);
    if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw bad('Pick a time in the future to clear it');
    if (until !== null && until > Date.now() + 366 * 864e5) throw bad('A status can last up to a year');
    q('UPDATE users SET status_emoji = ?, status_text = ?, status_until = ? WHERE id = ?').run(emoji, text, until, req.user.id);
    statusChanged(req.user);
    res.json({ status: statusOf({ status_emoji: emoji, status_text: text, status_until: until }) });
  });
  r.delete('/me/status', (req, res) => {
    q('UPDATE users SET status_emoji = NULL, status_text = NULL, status_until = NULL WHERE id = ?').run(req.user.id);
    statusChanged(req.user);
    res.json({ status: null });
  });

  // Find someone in another company by exact address (only if both companies allow it).
  r.get('/lookup', (req, res) => {
    const address = String(req.query.email || '').trim().toLowerCase();
    const u = q(`SELECT u.id, u.username, u.name, o.name AS org_name FROM users u JOIN orgs o ON o.id = u.org_id
                 WHERE u.username = ? AND u.disabled = 0`).get(address);
    if (!u || !canReach(req.user, u.id)) throw notFound(`No reachable person has the address ${address}`);
    res.json(u);
  });

  r.use(requireAdmin);

  r.get('/', (req, res) => {
    const orgId = targetOrg(req);
    res.json(q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.created_at, u.mail_quota_mb, u.last_active,
                  (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used,
                  (SELECT COUNT(*) FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AS two_factor
                FROM users u WHERE u.org_id = ? ORDER BY u.name`).all(orgId));
  });

  // Everyone in the company as a spreadsheet (CSV), for audits or moving elsewhere.
  r.get('/export', (req, res) => {
    const orgId = targetOrg(req);
    const rows = q(`SELECT u.username, u.name, u.is_admin, u.disabled, u.created_at,
                      (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used,
                      (SELECT COUNT(*) FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AS two_factor,
                      MAX(COALESCE(u.last_active, 0), COALESCE((SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id), 0)) AS last_active
                    FROM users u WHERE u.org_id = ? ORDER BY u.name COLLATE NOCASE`).all(orgId);
    audit(req, 'user.export', { org: orgId, details: { people: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="people.csv"');
    res.send(usersCsv(rows));
  });

  r.post('/', (req, res) => {
    const orgId = targetOrg(req);
    const username = validAddress(req.body.local, req.body.domain, orgId);
    const name = str(req.body.name, { required: true, name: 'Name', max: 100 });
    validatePassword(req.body.password);
    const id = newUserRow({ orgId, username, name, password: req.body.password, is_admin: !!req.body.is_admin });
    audit(req, 'user.create', { org: orgId, target: username, details: { admin: !!req.body.is_admin } });
    res.status(201).json({ id, username });
  });

  // Many people from a CSV: { csv, domain, dry_run }. A dry run only checks; otherwise the good rows
  // are created (all or nothing per row) and the results list each row, with made-up passwords.
  r.post('/import', (req, res) => {
    const orgId = targetOrg(req);
    let plan;
    try { plan = planImport(String(req.body.csv || ''), { orgId, domain: String(req.body.domain || '').trim().toLowerCase() || null }); }
    catch (e) { throw bad(e.message); }
    if (req.body.dry_run) return res.json({ rows: plan.map(({ password, ...p }) => ({ ...p, has_password: !!password })) });
    const rows = [];
    for (const p of plan) {
      if (p.error) { rows.push({ line: p.line, name: p.name, email: p.email, error: p.error }); continue; }
      const made = !p.password;
      const password = p.password || readablePassword();
      try {
        newUserRow({ orgId, username: p.email, name: p.name, password, is_admin: p.admin });
        audit(req, 'user.create', { org: orgId, target: p.email, details: { admin: p.admin, imported: true } });
        rows.push({ line: p.line, name: p.name, email: p.email, admin: p.admin, created: true, ...(made && { password }) });
      } catch (e) { rows.push({ line: p.line, name: p.name, email: p.email, error: e.message }); }
    }
    res.json({ rows, created: rows.filter((x) => x.created).length });
  });

  r.patch('/:id', (req, res) => {
    const u = loadManagedUser(req);
    const self = u.id === req.user.id;
    const { name, is_admin, disabled, password, mail_quota_mb, reset_two_factor } = req.body;
    if (u.is_super && !req.user.is_super) throw forbidden('Only the platform owner can change this account');
    // A new address (another name, or another of the company's domains). Mail stays where it is.
    if (req.body.local !== undefined || req.body.domain !== undefined) {
      const [oldLocal, oldDomain] = u.username.split('@');
      const local = String(req.body.local ?? oldLocal).trim().toLowerCase(), domain = String(req.body.domain ?? oldDomain).trim().toLowerCase();
      if (`${local}@${domain}` !== u.username) renameAddress(u, validAddress(local, domain, u.org_id), req.body.keep_old_address !== false);
    }
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), u.id);
    if (is_admin !== undefined) {
      if (self && !is_admin) throw bad('You cannot remove your own admin rights');
      q('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, u.id);
    }
    if (disabled !== undefined) {
      if (self) throw bad('You cannot disable yourself');
      q('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id);
      if (disabled) q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (password !== undefined) {
      validatePassword(password);
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      setMailPassword(u.id, password);
      // A reset (e.g. after a break-in) also removes the mail-app password, so only the new password works anywhere.
      q('UPDATE users SET mail_app_hash = NULL, mail_app_created = NULL WHERE id = ?').run(u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    // Lost phone: turn off their two-step verification so they can sign in with the password and set
    // it up again. Their sessions end, so the change is noticed.
    if (reset_two_factor) {
      if (self) throw bad('Turn off your own two-step verification in Settings');
      disableTwoFactor(u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (mail_quota_mb !== undefined) {
      const mb = Math.trunc(Number(mail_quota_mb));
      if (!Number.isFinite(mb) || mb < 0) throw bad('Mailbox size must be 0 (unlimited) or more');
      q('UPDATE users SET mail_quota_mb = ? WHERE id = ?').run(mb, u.id);
    }
    scheduleMailConfig();
    const changed = Object.fromEntries(Object.entries({ name, is_admin, disabled, mail_quota_mb, reset_two_factor, password: password !== undefined ? 'reset' : undefined,
      address: req.body.local !== undefined || req.body.domain !== undefined ? q('SELECT username FROM users WHERE id = ?').get(u.id)?.username : undefined }).filter(([, v]) => v !== undefined));
    if (Object.keys(changed).length) audit(req, 'user.update', { org: u.org_id, target: u.username, details: changed });
    res.json({ ok: true });
  });

  // Permanently delete a user and everything they own.
  r.delete('/:id', (req, res) => {
    const u = loadManagedUser(req);
    if (u.id === req.user.id) throw bad('You cannot delete yourself');
    if (u.is_super) throw bad('The platform owner account cannot be deleted');
    // Their Drive can go to a colleague first (into a "Files from …" folder), instead of being deleted.
    let heir = null;
    if (req.query.transfer_to) {
      heir = q('SELECT id, name, org_id, disabled FROM users WHERE id = ?').get(String(req.query.transfer_to));
      if (!heir || heir.disabled || heir.org_id !== u.org_id || heir.id === u.id) throw bad('Choose someone else in the same company to give their files to');
    }
    const blobs = tx(() => {
      let moved = 0;
      if (heir) {
        const roots = q('SELECT id, name FROM files WHERE owner_id = ? AND parent_id IS NULL').all(u.id);
        if (roots.length) {
          const folder = insertFile({ owner: heir.id, parentId: null, name: `Files from ${q("SELECT name FROM users WHERE id = ?").get(u.id).name}`.slice(0, 255), kind: 'folder' });
          for (const f of roots) q('UPDATE files SET parent_id = ?, name = ? WHERE id = ?').run(folder, uniqueName(folder, heir.id, f.name), f.id);
        }
        moved = q('UPDATE files SET owner_id = ? WHERE owner_id = ?').run(heir.id, u.id).changes;
        q('DELETE FROM shares WHERE user_id = ? AND file_id IN (SELECT id FROM files WHERE owner_id = ?)').run(heir.id, heir.id);
      }
      req.moved = moved;
      const list = blobsOwnedBy('?', u.id);
      q('UPDATE domains SET catchall = NULL WHERE catchall = (SELECT username FROM users WHERE id = ?)').run(u.id);
      // Their mail stays on the mail server; whoever gets this address next starts with an empty mailbox.
      retireMailHome(q('SELECT username, mail_home FROM users WHERE id = ?').get(u.id));
      q('DELETE FROM users WHERE id = ?').run(u.id);
      fs.rmSync(photoFile(u.id), { force: true });
      return list;
    });
    removeBlobs(blobs);
    scheduleMailConfig();
    audit(req, 'user.delete', { org: u.org_id, target: u.username, ...(heir && { details: { files_to: heir.name, items: req.moved } }) });
    res.json({ ok: true, files_moved: req.moved || 0 });
  });

  return r;
}
