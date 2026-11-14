import { cleanCalPrefs, colorRulesOf } from '../calprefs.js';
import { securityActivity } from '../securityactivity.js';
import { checkFull } from '../mail/storage.js';
import { activePerDay } from '../activedays.js';
import { syncCompanyGroupAliases } from '../groups.js';
import { mailEnabled } from '../mail/config.js';
import { digestFor, sendDigest, digestOff, setDigestOff, DIGEST_PARTS } from '../digest.js';
import { zoneOrUtc } from '../ics.js';
import { disable as disableTwoFactor } from '../twofactor.js';
import { audit } from '../audit.js';
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import { orgMemberIds } from '../tenancy.js';
import { q, tx } from '../db.js';
import { str, bad, notFound, forbidden } from '../util.js';
import { setHold, keepIfHeld } from '../hold.js';
import { requireAdmin, validatePassword, hashPassword, newUserRow, sessionId, describeDevice, destroySession, tokenFromReq, driveView, homeLayout, HOME_CARDS } from '../auth.js';
import { validAddress, canReach, blobsOwnedBy, removeBlobs, mailHomeOf, retireMailHome } from '../tenancy.js';
import { uid } from '../util.js';
import { planImport, readablePassword, usersCsv } from '../userimport.js';
import { sendTo } from '../hub.js';
import { hoursOf, setHours, readHours, hoursText, withinHours, quietUntil } from '../workhours.js';
import { insertFile, uniqueName, keepDriveFiles } from './files.js';
import { focusUntil, calendarStatus, baseUrl } from './calendar.js';
import { placeOn } from './location.js';
import { awayOfIds, afterHoursOfIds } from '../mail/afterhours.js';

// Who's who: a job title, department and work phone for each person, and who they report to (set by
// an admin). The Directory shows them, with an org chart.
for (const c of ['job_title TEXT', 'department TEXT', 'work_phone TEXT', 'manager_id TEXT REFERENCES users(id) ON DELETE SET NULL']) {
  if (!q('PRAGMA table_info(users)').all().some((x) => x.name === c.split(' ')[0])) q(`ALTER TABLE users ADD COLUMN ${c}`).run();
}
/** The profile fields in a request body that were given, cleaned ({ job_title, department, work_phone }). */
function readProfile(b) {
  const out = {};
  if (b.job_title !== undefined) out.job_title = str(b.job_title ?? '', { max: 100, name: 'Job title' }) || null;
  if (b.department !== undefined) out.department = str(b.department ?? '', { max: 100, name: 'Department' }) || null;
  if (b.work_phone !== undefined) {
    const p = str(b.work_phone ?? '', { max: 40, name: 'Phone' }) || null;
    if (p && !/^[+()\d\s.\-\/x]+$/i.test(p)) throw bad('A phone number has digits, spaces and + ( ) - only');
    out.work_phone = p;
  }
  return out;
}
const saveProfile = (id, fields) => { for (const [k, v] of Object.entries(fields)) q(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, id); };
/** Set who someone reports to: a colleague, never themselves or someone who reports to them. */
function setManager(u, managerId) {
  if (!managerId) { q('UPDATE users SET manager_id = NULL WHERE id = ?').run(u.id); return; }
  const m = q('SELECT id, org_id FROM users WHERE id = ?').get(String(managerId));
  if (!m || m.org_id !== u.org_id) throw bad('Their manager must be in the same company');
  for (let cur = m.id, i = 0; cur && i < 200; i++) {
    if (cur === u.id) throw bad('That would make a loop: they can’t report to someone who reports to them');
    cur = q('SELECT manager_id FROM users WHERE id = ?').get(cur)?.manager_id;
  }
  q('UPDATE users SET manager_id = ? WHERE id = ?').run(m.id, u.id);
}

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

// The statuses you set lately (with how soon you had each cleared), to set again in one click.
q(`CREATE TABLE IF NOT EXISTS status_recent (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  clear TEXT NOT NULL DEFAULT '',
  used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, emoji, text)
)`).run();
export const MAX_RECENT_STATUSES = 5;
export const STATUS_CLEARS = ['', '30m', '1h', '4h', 'today', 'week'];
function rememberStatus(userId, emoji, text, clear) {
  const c = STATUS_CLEARS.includes(clear) ? clear : '';
  q(`INSERT INTO status_recent (user_id, emoji, text, clear, used_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, emoji, text) DO UPDATE SET clear = excluded.clear, used_at = excluded.used_at`)
    .run(userId, emoji || '', text || '', c, Math.max(Date.now(), (q('SELECT MAX(used_at) AS t FROM status_recent WHERE user_id = ?').get(userId).t || 0) + 1));
  q(`DELETE FROM status_recent WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM status_recent WHERE user_id = ? ORDER BY used_at DESC LIMIT ${MAX_RECENT_STATUSES})`).run(userId, userId);
}
/** Your recent statuses, latest first: [{ emoji, text, clear }]. */
export const recentStatuses = (userId) => q('SELECT emoji, text, clear FROM status_recent WHERE user_id = ? ORDER BY used_at DESC').all(userId)
  .map((r) => ({ emoji: r.emoji || null, text: r.text || null, clear: r.clear }));

export default function userRoutes() {
  const r = Router();

  // Everyone: your own company's directory (for sharing, chat, contacts).
  r.get('/directory', (req, res) => {
    const now = Date.now();
    res.json(q('SELECT id, username, name, job_title, department, work_phone, manager_id, status_emoji, status_text, status_until, paused_until FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name')
      .all(req.user.org_id).map(({ status_emoji, status_text, status_until, paused_until, ...u }) => ({ ...u, status: statusOf({ status_emoji, status_text, status_until }) || calendarStatus(u.id), paused_until: Math.max(paused_until > now ? paused_until : 0, quietUntil(u.id, now) || 0) || null })));
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
  // A colleague's card: who they are, who they report to and who reports to them, how to reach them,
  // whether it's working time for them now, and where they're working today.
  // Whether a colleague can be reached now: away (their vacation reply is on today), and/or outside the working
  // hours they've set (their local time, when they start again). { away, after } (null when not).
  // Several at once (?ids=a,b,c, up to 50): [{ id, name, away, after }] for those away or outside their hours.
  r.get('/availability', (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))].slice(0, 50);
    const away = new Map(awayOfIds(req.user, ids).map((x) => [x.id, x]));
    const after = new Map(afterHoursOfIds(req.user, ids).map((x) => [x.id, x]));
    res.json(ids.filter((id) => away.has(id) || after.has(id)).map((id) => {
      const a = away.get(id), h = after.get(id);
      return { id, name: (a || h).name, away: a ? { until: a.until, subject: a.subject } : null, after: h ? { local: h.local, tz: h.tz, next: h.next } : null };
    }));
  });
  r.get('/:id/availability', (req, res) => {
    const u = q('SELECT id, org_id FROM users WHERE id = ? AND disabled = 0').get(req.params.id);
    if (!u || u.org_id !== req.user.org_id) throw notFound();
    const [away] = awayOfIds(req.user, [u.id]);
    const [after] = afterHoursOfIds(req.user, [u.id]);
    res.json({ away: away ? { until: away.until, subject: away.subject } : null, after: after ? { local: after.local, tz: after.tz, next: after.next } : null });
  });

  r.get('/:id/card', (req, res) => {
    const u = q(`SELECT id, username, name, job_title, department, work_phone, manager_id, status_emoji, status_text, status_until, paused_until, org_id, photo_v
                 FROM users WHERE id = ? AND disabled = 0`).get(String(req.params.id));
    if (!u || u.org_id !== req.user.org_id) throw notFound('No such person');
    const brief = (x) => x && { id: x.id, name: x.name, job_title: x.job_title || null };
    const now = Date.now();
    const hours = hoursOf(u.id, 'UTC');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: hours.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    const p = placeOn(u.id, day);
    res.json({
      id: u.id, name: u.name, email: u.username, job_title: u.job_title || null, department: u.department || null, work_phone: u.work_phone || null,
      has_photo: !!u.photo_v,
      manager: brief(u.manager_id && q('SELECT id, name, job_title FROM users WHERE id = ? AND disabled = 0').get(u.manager_id)),
      reports: q('SELECT id, name, job_title FROM users WHERE manager_id = ? AND disabled = 0 ORDER BY name').all(u.id).map(brief),
      status: statusOf(u, now) || calendarStatus(u.id),
      paused_until: u.paused_until > now ? u.paused_until : null,
      hours: hours.own ? { tz: hours.tz, text: hoursText(hours), working_now: withinHours(now, now + 6e4, hours) } : null,
      where_today: p ? { place: p.place, label: p.label } : null,
    });
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

  // What documents, spreadsheets and presentations download as in a .zip or your data: { format: 'office' | 'odf' }.
  r.put('/me/file-format', (req, res) => {
    const format = req.body?.format;
    if (format !== 'office' && format !== 'odf') throw bad('Choose Microsoft Office or OpenDocument');
    q('UPDATE users SET file_format = ? WHERE id = ?').run(format, req.user.id);
    res.json({ file_format: format });
  });

  // How Drive lists your files (sort, order, list or grid), the same on every computer: { sort?, desc?, layout? }.
  r.put('/me/drive-view', (req, res) => {
    const b = req.body || {};
    if (b.sort !== undefined && !['name', 'modified', 'size'].includes(b.sort)) throw bad('Sort by name, modified or size');
    if (b.layout !== undefined && !['list', 'grid'].includes(b.layout)) throw bad('Show a list or a grid');
    const cur = driveView(q('SELECT drive_view FROM users WHERE id = ?').get(req.user.id)?.drive_view);
    const next = driveView({ ...cur, ...(b.sort !== undefined && { sort: b.sort }), ...(b.desc !== undefined && { desc: !!b.desc }), ...(b.layout !== undefined && { layout: b.layout }) });
    q('UPDATE users SET drive_view = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
    res.json(next);
  });

  // Home's cards: their order and which are hidden ({ order: [cards], hidden: [cards] }); { reset: true } goes back to the usual.
  r.put('/me/home-layout', (req, res) => {
    const b = req.body || {};
    if (b.reset) { q('UPDATE users SET home_layout = NULL WHERE id = ?').run(req.user.id); return res.json(homeLayout(null)); }
    const known = (list) => Array.isArray(list) && list.every((k) => HOME_CARDS.includes(k));
    if (b.order !== undefined && !known(b.order)) throw bad('Unknown card in the order');
    if (b.hidden !== undefined && !known(b.hidden)) throw bad('Unknown card to hide');
    const cur = homeLayout(q('SELECT home_layout FROM users WHERE id = ?').get(req.user.id)?.home_layout);
    const next = homeLayout({ order: b.order ?? cur.order, hidden: b.hidden ?? cur.hidden });
    if (next.hidden.length === HOME_CARDS.length) throw bad('Keep at least one card on Home');
    q('UPDATE users SET home_layout = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
    res.json(next);
  });

  // Your recent searches in the top bar (newest first, at most 8, the same on every computer).
  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'recent_searches')) q('ALTER TABLE users ADD COLUMN recent_searches TEXT').run();
  const recentOf = (id) => { try { return JSON.parse(q('SELECT recent_searches FROM users WHERE id = ?').get(id)?.recent_searches || '[]'); } catch { return []; } };
  r.get('/me/recent-searches', (req, res) => res.json(recentOf(req.user.id)));
  r.post('/me/recent-searches', (req, res) => {
    const text = String(req.body?.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text.length < 2) throw bad('Search for at least two letters');
    const list = [text, ...recentOf(req.user.id).filter((x) => x.toLowerCase() !== text.toLowerCase())].slice(0, 8);
    q('UPDATE users SET recent_searches = ? WHERE id = ?').run(JSON.stringify(list), req.user.id);
    res.json(list);
  });
  r.delete('/me/recent-searches', (req, res) => {
    const one = req.query.q !== undefined ? String(req.query.q).toLowerCase() : null;
    const list = one === null ? [] : recentOf(req.user.id).filter((x) => x.toLowerCase() !== one);
    q('UPDATE users SET recent_searches = ? WHERE id = ?').run(list.length ? JSON.stringify(list) : null, req.user.id);
    res.json(list);
  });

  // Calendar's world clock: the time zones to show, in order ({ zones: ['Asia/Tokyo', …] }, at most 8).
  r.put('/me/world-clocks', (req, res) => {
    const list = Array.isArray(req.body?.zones) ? req.body.zones.map(String) : null;
    if (!list) throw bad('Give a list of time zones');
    if (list.length > 8) throw bad('At most 8 clocks');
    const zones = [];
    for (const z of list) {
      let real;
      try { real = new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone; } catch { throw bad(`“${z}” isn’t a time zone`); }
      if (!zones.includes(real)) zones.push(real);
    }
    q('UPDATE users SET world_clocks = ? WHERE id = ?').run(zones.length ? JSON.stringify(zones) : null, req.user.id);
    res.json({ zones });
  });

  // Calendar settings: { length, speedy, reminders } (calprefs.js); { reset: true } goes back to the defaults.
  r.put('/me/calendar-prefs', (req, res) => {
    // Only what's given changes (the sidebar sets one switch; the settings dialog sends them all).
    const cur = JSON.parse(q('SELECT cal_prefs FROM users WHERE id = ?').get(req.user.id)?.cal_prefs || 'null') || {};
    if (req.body?.colorRules !== undefined) { try { colorRulesOf(req.body.colorRules, { strict: true }); } catch (e) { throw bad(e.message); } }
    const p = req.body?.reset ? null : cleanCalPrefs({ ...cur, ...(req.body || {}) });
    q('UPDATE users SET cal_prefs = ? WHERE id = ?').run(p ? JSON.stringify(p) : null, req.user.id);
    res.json(p || cleanCalPrefs(null));
  });

  // Calls: pop up on screen (📞 … is calling you, with Join) or not; either way they reach the bell.
  r.put('/me/ring', (req, res) => {
    const on = req.body?.on !== false;
    q('UPDATE users SET ring_off = ? WHERE id = ?').run(on ? 0 : 1, req.user.id);
    res.json({ ring: on });
  });

  // Tips while writing mail (Include …?, after their working hours, away, full mailbox, many people, outside the company): on or off.
  r.put('/me/mail-tips', (req, res) => {
    const on = req.body?.on !== false;
    q('UPDATE users SET mail_tips_off = ? WHERE id = ?').run(on ? 0 : 1, req.user.id);
    res.json({ mail_tips: on });
  });

  // The search box's tips ("Type to make things": event …, task …, note …): shown in the empty box, or hidden.
  r.put('/me/search-tips', (req, res) => {
    const on = req.body?.on !== false;
    q('UPDATE users SET search_tips_off = ? WHERE id = ?').run(on ? 0 : 1, req.user.id);
    res.json({ search_tips: on });
  });

  // Single-key shortcuts (C to write, J/K, G then M, ? for the list): on or off. Shortcuts with Ctrl or ⌘ stay.
  r.put('/me/keys', (req, res) => {
    const on = req.body?.on !== false;
    q('UPDATE users SET keys_off = ? WHERE id = ?').run(on ? 0 : 1, req.user.id);
    res.json({ keys: on });
  });

  // Mail: what opens after you archive, delete, move or snooze the message you're reading:
  // { advance: 'newer' | 'older' | 'list' } (the next newer one, the next older one, or back to the list).
  r.put('/me/mail-advance', (req, res) => {
    const a = req.body?.advance;
    if (!['newer', 'older', 'list'].includes(a)) throw bad('Choose newer, older or list');
    q('UPDATE users SET mail_advance = ? WHERE id = ?').run(a === 'list' ? null : a, req.user.id);
    res.json({ advance: a });
  });

  // Mail's reading pane: { pane: 'right' | 'below' | 'off' } (beside the list, under it, or none: a message
  // you open takes the whole width, with a way back to the list).
  r.put('/me/mail-pane', (req, res) => {
    const p = req.body?.pane;
    if (!['right', 'below', 'off'].includes(p)) throw bad('Choose right, below or off');
    q('UPDATE users SET mail_pane = ? WHERE id = ?').run(p === 'right' ? null : p, req.user.id);
    res.json({ pane: p });
  });

  // How wide Mail's list is beside the reading pane (dragging the line between them): { width } in pixels,
  // 260 to 800, or null for the usual.
  r.put('/me/mail-list-width', (req, res) => {
    const w = req.body?.width;
    if (w !== null && !(Number.isFinite(w) && w >= 260 && w <= 800)) throw bad('The list can be 260 to 800 pixels wide');
    const width = w === null ? null : Math.round(w);
    q('UPDATE users SET mail_list_width = ? WHERE id = ?').run(width, req.user.id);
    res.json({ width });
  });

  // How Mail's message list looks: { pictures, compact } (each optional: what's left out stays as it was).
  // Sender pictures (a colleague's photo, or initials) beside each message; compact rows fit more on the screen.
  r.put('/me/mail-list', (req, res) => {
    let now; try { now = JSON.parse(q('SELECT mail_list FROM users WHERE id = ?').get(req.user.id)?.mail_list || '{}'); } catch { now = {}; }
    const next = { pictures: !!now.pictures, compact: !!now.compact };
    for (const k of ['pictures', 'compact']) {
      if (req.body?.[k] === undefined) continue;
      if (typeof req.body[k] !== 'boolean') throw bad(`${k} must be true or false`);
      next[k] = req.body[k];
    }
    q('UPDATE users SET mail_list = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
    res.json(next);
  });

  // Convert Office, OpenDocument and Markdown files you upload in Drive: { on: true | false }.
  r.put('/me/convert-uploads', (req, res) => {
    const on = !!req.body?.on;
    q('UPDATE users SET convert_uploads = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
    res.json({ convert_uploads: on });
  });

  // Where Workspace opens for you: { page: 'drive' | 'home' }.
  // Your own job title, department and phone ({ job_title, department, work_phone }).
  r.put('/me/profile', (req, res) => {
    saveProfile(req.user.id, readProfile(req.body || {}));
    sendTo(orgMemberIds(req.user.org_id), { type: 'directory-changed' });
    res.json(q('SELECT job_title, department, work_phone, manager_id FROM users WHERE id = ?').get(req.user.id));
  });

  // Whether owners and editors see when you open their files (Drive → Details → Who has seen it).
  r.get('/me/view-history', (req, res) => res.json({ show: !q('SELECT hide_views FROM users WHERE id = ?').get(req.user.id)?.hide_views }));
  r.put('/me/view-history', (req, res) => {
    const show = req.body?.show !== false;
    q('UPDATE users SET hide_views = ? WHERE id = ?').run(show ? 0 : 1, req.user.id);
    if (!show) q('DELETE FROM file_views WHERE user_id = ?').run(req.user.id); // and forget the ones already kept
    res.json({ show });
  });

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
    const quiet = quietUntil(req.user.id); // outside working hours, with quiet hours on
    const best = Math.max(until > Date.now() ? until : 0, focus || 0, quiet || 0);
    res.json({ paused_until: best || null, focus: !!focus && focus >= Math.max(until || 0, quiet || 0), quiet: !!quiet && quiet === best && quiet > (until || 0) && quiet > (focus || 0) });
  });
  // The morning summary email: { hour: 0–23 or null (off), tz }; and one now ({ preview } without email).
  r.get('/me/digest', (req, res) => {
    const u = q('SELECT digest_hour, digest_tz FROM users WHERE id = ?').get(req.user.id);
    res.json({ hour: u.digest_hour, tz: u.digest_tz, mail: mailEnabled(), off: digestOff(req.user.id), ...(({ digest_weekdays: w, digest_skip_empty: e }) => ({ weekdays: !!w, skip_empty: !!e }))(q('SELECT digest_weekdays, digest_skip_empty FROM users WHERE id = ?').get(req.user.id)) });
  });
  // When it comes: { weekdays: true } Monday to Friday only; { skip_empty: true } only when there's something in it.
  r.put('/me/digest/days', (req, res) => {
    if ('weekdays' in (req.body || {})) q('UPDATE users SET digest_weekdays = ? WHERE id = ?').run(req.body.weekdays ? 1 : 0, req.user.id);
    if ('skip_empty' in (req.body || {})) q('UPDATE users SET digest_skip_empty = ? WHERE id = ?').run(req.body.skip_empty ? 1 : 0, req.user.id);
    const u = q('SELECT digest_weekdays, digest_skip_empty FROM users WHERE id = ?').get(req.user.id);
    res.json({ weekdays: !!u.digest_weekdays, skip_empty: !!u.digest_skip_empty });
  });
  // Which parts to leave out of it: { off: ['chat', 'drive'] } (events, tasks, chat, comments, drive).
  r.put('/me/digest/parts', (req, res) => {
    if (!Array.isArray(req.body?.off)) throw bad('Say which parts to leave out');
    if (req.body.off.length >= DIGEST_PARTS.length && DIGEST_PARTS.every((p) => req.body.off.includes(p))) throw bad('Keep at least one part in the summary');
    res.json({ off: setDigestOff(req.user.id, req.body.off) });
  });
  r.put('/me/digest', (req, res) => {
    const hour = req.body?.hour === null || req.body?.hour === undefined || req.body?.hour === '' ? null : Number(req.body.hour);
    if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw bad('Pick an hour from 0 to 23');
    if (hour !== null && !mailEnabled()) throw bad('Email is off on this server, so summaries can’t be sent');
    q('UPDATE users SET digest_hour = ?, digest_tz = ? WHERE id = ?').run(hour, zoneOrUtc(String(req.body?.tz || 'UTC')), req.user.id);
    res.json({ hour });
  });
  r.post('/me/digest/send', async (req, res) => {
    const base = baseUrl(req); // links in it go to where this was asked from, unless PUBLIC_URL says otherwise
    if (req.body?.preview || !mailEnabled()) return res.json({ sent: false, ...digestFor(req.user.id, Date.now(), base) });
    res.json({ sent: true, ...(await sendDigest(req.user.id, Date.now(), base)) });
  });

  // Quiet hours: pause notifications outside your working hours (set in Calendar → Working hours).
  r.get('/me/quiet-hours', (req, res) => {
    const h = hoursOf(req.user.id);
    res.json({ on: !!q('SELECT quiet_hours FROM users WHERE id = ?').get(req.user.id).quiet_hours, hours: h.own ? hoursText(h) : null, tz: h.own ? h.tz : null });
  });
  r.put('/me/quiet-hours', (req, res) => {
    const on = !!req.body?.on;
    if (on && !hoursOf(req.user.id).own) throw bad('Set your working hours first (Calendar → Working hours)');
    q('UPDATE users SET quiet_hours = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
    statusChanged(req.user);
    res.json({ on });
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
    res.json({ status: statusOf(q('SELECT status_emoji, status_text, status_until FROM users WHERE id = ?').get(req.user.id)), recent: recentStatuses(req.user.id) });
  });
  // Forget one of your recent statuses.
  r.post('/me/status/recent/forget', (req, res) => {
    q('DELETE FROM status_recent WHERE user_id = ? AND emoji = ? AND text = ?').run(req.user.id, String(req.body.emoji || ''), String(req.body.text || ''));
    res.json({ recent: recentStatuses(req.user.id) });
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
    rememberStatus(req.user.id, emoji, text, req.body.clear);
    statusChanged(req.user);
    res.json({ status: statusOf({ status_emoji: emoji, status_text: text, status_until: until }), recent: recentStatuses(req.user.id) });
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
    res.json(q(`SELECT u.id, u.username, u.name, u.is_admin, u.is_super, u.disabled, u.created_at, u.legal_hold, u.hold_note, u.hold_at, (SELECT name FROM users b WHERE b.id = u.hold_by) AS hold_by_name, u.mail_quota_mb, u.drive_quota_mb, u.last_active, u.job_title, u.department, u.work_phone, u.manager_id,
                  (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used,
                  (SELECT COUNT(*) FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AS two_factor, (SELECT COUNT(*) FROM passkeys pk WHERE pk.user_id = u.id) AS passkeys, (SELECT COUNT(*) FROM passkeys pk WHERE pk.user_id = u.id) AS passkeys
                FROM users u WHERE u.org_id = ? ORDER BY u.name`).all(orgId));
  });

  // Everyone in the company as a spreadsheet (CSV), for audits or moving elsewhere.
  r.get('/export', (req, res) => {
    const orgId = targetOrg(req);
    const rows = q(`SELECT u.username, u.name, u.is_admin, u.disabled, u.created_at, u.job_title, u.department, u.work_phone,
                      (SELECT m.username FROM users m WHERE m.id = u.manager_id) AS manager_email,
                      (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used,
                      (SELECT COUNT(*) FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AS two_factor, (SELECT COUNT(*) FROM passkeys pk WHERE pk.user_id = u.id) AS passkeys,
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
    validatePassword(req.body.password, { orgId, email: username, name });
    const id = newUserRow({ orgId, username, name, password: req.body.password, is_admin: !!req.body.is_admin });
    if (req.body.must_change_password) q('UPDATE users SET must_change_password = 1 WHERE id = ?').run(id);
    audit(req, 'user.create', { org: orgId, target: username, details: { admin: !!req.body.is_admin, must_change_password: !!req.body.must_change_password } });
    res.status(201).json({ id, username });
  });

  // Many people from a CSV: { csv, domain, dry_run }. A dry run only checks; otherwise the good rows
  // are created (all or nothing per row) and the results list each row, with made-up passwords.
  r.post('/import', (req, res) => {
    const orgId = targetOrg(req);
    let plan;
    try { plan = planImport(String(req.body.csv || ''), { orgId, domain: String(req.body.domain || '').trim().toLowerCase() || null }); }
    catch (e) { throw bad(e.message); }
    if (req.body.dry_run) return res.json({ rows: plan.map(({ password, update, ...p }) => ({ ...p, has_password: !!password, ...(update && { update: true }) })) });
    const rows = [];
    const details = (p) => ({ job_title: p.job_title, department: p.department, work_phone: p.work_phone });
    const given = (p) => Object.fromEntries(Object.entries(details(p)).filter(([, v]) => v !== null)); // empty cells leave what's there
    for (const p of plan) {
      if (p.error) { rows.push({ line: p.line, name: p.name, email: p.email, error: p.error }); continue; }
      if (p.update) {
        saveProfile(p.update, given(p));
        rows.push({ line: p.line, name: p.name, email: p.email, updated: true });
        continue;
      }
      const made = !p.password;
      const password = p.password || readablePassword();
      try {
        const id = newUserRow({ orgId, username: p.email, name: p.name, password, is_admin: p.admin });
        q("UPDATE users SET must_change_password = 1 WHERE id = ?").run(id); // made-up password: they choose their own at first sign-in
        saveProfile(typeof id === 'string' ? id : q('SELECT id FROM users WHERE username = ?').get(p.email).id, given(p));
        audit(req, 'user.create', { org: orgId, target: p.email, details: { admin: p.admin, imported: true } });
        rows.push({ line: p.line, name: p.name, email: p.email, admin: p.admin, created: true, ...(made && { password }) });
      } catch (e) { rows.push({ line: p.line, name: p.name, email: p.email, error: e.message }); }
    }
    // Managers last, once everyone in the file exists (by their address, in this company).
    for (const p of plan) {
      if (p.error || !p.manager) continue;
      const row = rows.find((x) => x.line === p.line);
      const u = q('SELECT id, org_id FROM users WHERE username = ? AND org_id = ?').get(p.email, orgId);
      const m = q('SELECT id FROM users WHERE username = ? AND org_id = ?').get(p.manager, orgId);
      if (!u || !row || row.error) continue;
      if (!m) { row.warning = `No one called ${p.manager} here, so no manager was set`; continue; }
      try { setManager(u, m.id); } catch (e) { row.warning = e.message; }
    }
    if (rows.some((x) => x.created || x.updated)) sendTo(orgMemberIds(orgId), { type: 'directory-changed' });
    res.json({ rows, created: rows.filter((x) => x.created).length, updated: rows.filter((x) => x.updated).length });
  });

  // Usage over the last N days (7, 30 or 90) for everyone in the company: when each was last active,
  // files created and edited, chat messages sent, meetings organised (events with guests that took
  // place), tasks completed, and video meetings joined with the minutes spent in them. ?format=csv to download.
  r.get('/report', (req, res) => {
    const orgId = targetOrg(req);
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const to = Date.now(), from = to - days * 864e5;
    const people = q('SELECT id, name, username, last_active, disabled FROM users WHERE org_id = ? ORDER BY name').all(orgId);
    const count = (sql, ...args) => new Map(q(sql).all(...args).map((r) => [r.user_id, r.n]));
    const created = count(`SELECT user_id, COUNT(*) AS n FROM file_activity WHERE at >= ? AND action IN ('create', 'upload', 'copy') GROUP BY user_id`, from);
    const edited = count(`SELECT user_id, COUNT(DISTINCT file_id) AS n FROM file_activity WHERE at >= ? AND action IN ('edit', 'version') GROUP BY user_id`, from);
    const chats = count('SELECT user_id, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY user_id', from);
    const meetings = count(`SELECT e.owner_id AS user_id, COUNT(*) AS n FROM events e WHERE e.start >= ? AND e.start < ?
                            AND EXISTS (SELECT 1 FROM event_guests g WHERE g.event_id = e.id) GROUP BY e.owner_id`, from, to);
    const tasks = count(`SELECT COALESCE(t.done_by, t.assignee_id, t.created_by) AS user_id, COUNT(*) AS n FROM tasks t WHERE t.done_at >= ? GROUP BY 1`, from);
    // Meet: the video meetings each joined, and the minutes they were in them (within the period; one still going counts up to now).
    const calls = count('SELECT user_id, COUNT(DISTINCT code) AS n FROM meeting_attendance WHERE COALESCE(left_at, ?) >= ? AND joined_at < ? AND user_id IS NOT NULL GROUP BY user_id', to, from, to);
    const callMs = count(`SELECT user_id, SUM(MAX(0, MIN(COALESCE(left_at, ?), ?) - MAX(joined_at, ?))) AS n FROM meeting_attendance
                          WHERE COALESCE(left_at, ?) >= ? AND joined_at < ? AND user_id IS NOT NULL GROUP BY user_id`, to, to, from, to, from, to);
    const rows = people.map((u) => ({ id: u.id, name: u.name, email: u.username, disabled: !!u.disabled, last_active: u.last_active || null,
      files_created: created.get(u.id) || 0, files_edited: edited.get(u.id) || 0, chat_messages: chats.get(u.id) || 0, meetings: meetings.get(u.id) || 0, tasks_done: tasks.get(u.id) || 0,
      video_meetings: calls.get(u.id) || 0, video_minutes: Math.round((callMs.get(u.id) || 0) / 60e3) }));
    const active = rows.filter((r) => r.last_active && r.last_active >= from).length;
    if (req.query.format === 'csv') {
      const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : t; };
      const lines = [['Name', 'Email', 'Last active (UTC)', 'Files created', 'Files edited', 'Chat messages', 'Meetings organised', 'Tasks done', 'Video meetings joined', 'Minutes in video meetings', 'Suspended'],
        ...rows.map((r) => [r.name, r.email, r.last_active ? new Date(r.last_active).toISOString().slice(0, 16).replace('T', ' ') : 'never', r.files_created, r.files_edited, r.chat_messages, r.meetings, r.tasks_done, r.video_meetings, r.video_minutes, r.disabled ? 'yes' : ''])];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${days}-days.csv"`);
      return res.send(`\ufeff${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`);
    }
    // The company's video meetings in the period: how many were held, the time people spent in them, how long
    // a meeting lasted on average (first in to last out), and how many guests without an account came.
    const spans = q(`SELECT a.code, MIN(MAX(a.joined_at, ?)) AS first, MAX(MIN(COALESCE(a.left_at, ?), ?)) AS last,
                       SUM(MAX(0, MIN(COALESCE(a.left_at, ?), ?) - MAX(a.joined_at, ?))) AS ms, SUM(a.user_id IS NULL) AS guests
                     FROM meeting_attendance a JOIN meetings m ON m.code = a.code
                     WHERE m.org_id = ? AND COALESCE(a.left_at, ?) >= ? AND a.joined_at < ? GROUP BY a.code`).all(from, to, to, to, to, from, orgId, to, from, to);
    const meet = { meetings: spans.length, minutes: Math.round(spans.reduce((n, x) => n + x.ms, 0) / 60e3),
      avg_minutes: spans.length ? Math.round(spans.reduce((n, x) => n + Math.max(0, x.last - x.first), 0) / spans.length / 60e3) : 0,
      guests: spans.reduce((n, x) => n + x.guests, 0) };
    res.json({ days, from, to, active, people: rows, per_day: activePerDay(orgId, from, to), meet });
  });

  // Someone's recent security activity (sign-ins, failed attempts, sign-in changes; 30 days), for an admin.
  r.get('/:id/security-activity', (req, res) => {
    const u = loadManagedUser(req);
    if (u.is_super && !req.user.is_super) throw forbidden('Only the platform owner can see this account’s activity');
    res.json(securityActivity(u, { about: true, limit: 50 }));
  });
  // Someone's signed-in devices (web sessions), for an admin: see them and sign one or all out.
  r.get('/:id/sessions', (req, res) => {
    const u = loadManagedUser(req);
    if (u.is_super && !req.user.is_super) throw forbidden('Only the platform owner can see this account’s devices');
    const mine = tokenFromReq(req);
    res.json(q('SELECT token, created_at, last_seen, user_agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC').all(u.id, Date.now())
      .map((s) => ({ id: sessionId(s.token), device: describeDevice(s.user_agent || ''), ip: s.ip || null, created_at: s.created_at, last_seen: s.last_seen, yours: s.token === mine })));
  });
  r.delete('/:id/sessions/:sid', (req, res) => {
    const u = loadManagedUser(req);
    if (u.is_super && !req.user.is_super) throw forbidden('Only the platform owner can change this account');
    const rows = q('SELECT token FROM sessions WHERE user_id = ?').all(u.id);
    const hit = req.params.sid === 'all' ? null : rows.find((x) => sessionId(x.token) === req.params.sid);
    if (req.params.sid !== 'all' && !hit) throw notFound('That device is already signed out');
    const mine = tokenFromReq(req);
    const gone = hit ? [hit] : rows.filter((x) => x.token !== mine); // "all" never signs you out of the page you're on
    for (const x of gone) destroySession(x.token);
    if (gone.length) audit(req, 'session.revoke', { org: u.org_id, target: u.username, details: { devices: gone.length, by_admin: true } });
    res.json({ signedOut: gone.length });
  });

  // The same change for several people at once: { ids, action: suspend | restore | signout | department, value }.
  // Each is checked as for one (not yourself, not the platform owner unless you are it); returns
  // { done, skipped: [{ name, reason }] }.
  r.post('/bulk', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    const action = String(req.body?.action || '');
    if (!['suspend', 'restore', 'signout', 'department'].includes(action)) throw bad('Unknown action');
    if (!ids.length) throw bad('Choose people first');
    const department = action === 'department' ? String(req.body?.value ?? '').trim().slice(0, 100) : null;
    const done = [], skipped = [];
    const orgs = new Set();
    for (const id of ids) {
      const u = q('SELECT id, org_id, is_super, username, name, disabled FROM users WHERE id = ?').get(id);
      if (!u || (u.org_id !== req.user.org_id && !req.user.is_super)) { skipped.push({ name: id, reason: 'Not found' }); continue; }
      if (u.is_super && !req.user.is_super) { skipped.push({ name: u.name, reason: 'Only the platform owner can change this account' }); continue; }
      if (u.id === req.user.id && ['suspend', 'signout'].includes(action)) { skipped.push({ name: u.name, reason: action === 'suspend' ? 'You cannot suspend yourself' : 'Not your own account (use Settings → Signed-in devices)' }); continue; }
      if (action === 'suspend') { q('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id); q('DELETE FROM sessions WHERE user_id = ?').run(u.id); }
      if (action === 'restore') q('UPDATE users SET disabled = 0 WHERE id = ?').run(u.id);
      if (action === 'signout') q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      if (action === 'department') q('UPDATE users SET department = ? WHERE id = ?').run(department || null, u.id);
      orgs.add(u.org_id);
      done.push(u.username);
    }
    if (['suspend', 'restore'].includes(action)) { for (const o of orgs) syncCompanyGroupAliases(o); scheduleMailConfig(); }
    for (const o of orgs) sendTo(orgMemberIds(o), { type: 'directory-changed' });
    if (done.length) audit(req, `user.bulk.${action}`, { target: `${done.length} people`, details: { people: done.slice(0, 50), ...(action === 'department' && { department }) } });
    res.json({ done: done.length, skipped });
  });

  r.patch('/:id', (req, res) => {
    const u = loadManagedUser(req);
    const self = u.id === req.user.id;
    const { name, is_admin, disabled, password, mail_quota_mb, reset_two_factor, drive_quota_mb } = req.body;
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
      syncCompanyGroupAliases(u.org_id); // group email addresses reach active people only
    }
    if (password !== undefined) {
      validatePassword(password, { orgId: u.org_id, email: u.username, name: u.name });
      q('UPDATE users SET password_hash = ?, must_change_password = ?, password_set_at = ? WHERE id = ?').run(hashPassword(password), req.body.must_change_password && !self ? 1 : 0, Date.now(), u.id);
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
      q('DELETE FROM passkeys WHERE user_id = ?').run(u.id); // a lost phone may hold their passkey too
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    // Who's who (admins): title, department, phone and manager.
    const profile = readProfile(req.body);
    saveProfile(u.id, profile);
    if (req.body.manager_id !== undefined) setManager(u, req.body.manager_id);
    if (Object.keys(profile).length || req.body.manager_id !== undefined) sendTo(orgMemberIds(u.org_id), { type: 'directory-changed' });
    // Their own Drive storage limit in MB (null: only the company's).
    if (drive_quota_mb !== undefined) {
      const mb = drive_quota_mb === null || drive_quota_mb === '' ? null : Math.trunc(Number(drive_quota_mb));
      if (mb !== null && (!Number.isFinite(mb) || mb < 1 || mb > 10_000_000)) throw bad('Storage limit: a number of MB from 1, or none');
      q('UPDATE users SET drive_quota_mb = ? WHERE id = ?').run(mb, u.id);
    }
    // Legal hold: nothing of theirs is deleted for good until it's lifted (hold.js). A note says why.
    let hold;
    if (req.body.legal_hold !== undefined) {
      hold = !!req.body.legal_hold;
      const note = hold ? str(req.body.hold_note ?? '', { name: 'Reason', max: 300 }) || null : null;
      setHold(u.id, hold, { note, by: req.user.id });
      audit(req, hold ? 'user.hold' : 'user.release', { org: u.org_id, target: u.username, details: note ? { reason: note } : undefined });
    }
    if (mail_quota_mb !== undefined) {
      const mb = Math.trunc(Number(mail_quota_mb));
      if (!Number.isFinite(mb) || mb < 0) throw bad('Mailbox size must be 0 (unlimited) or more');
      q('UPDATE users SET mail_quota_mb = ? WHERE id = ?').run(mb, u.id);
      // A new limit can leave them nearly full: tell them now, not at the next hourly check.
      if (mb > 0) checkFull(q('SELECT * FROM users WHERE id = ?').get(u.id)).catch((e) => console.error('[mail] full:', e.message));
    }
    scheduleMailConfig();
    const changed = Object.fromEntries(Object.entries({ name, is_admin, disabled, mail_quota_mb, drive_quota_mb, reset_two_factor, ...profile, manager_id: req.body.manager_id, password: password !== undefined ? 'reset' : undefined,
      address: req.body.local !== undefined || req.body.domain !== undefined ? q('SELECT username FROM users WHERE id = ?').get(u.id)?.username : undefined }).filter(([, v]) => v !== undefined));
    if (Object.keys(changed).length) audit(req, 'user.update', { org: u.org_id, target: u.username, details: changed });
    res.json({ ok: true });
  });

  // Permanently delete a user and everything they own.
  r.delete('/:id', (req, res) => {
    const u = loadManagedUser(req);
    if (u.id === req.user.id) throw bad('You cannot delete yourself');
    if (u.is_super) throw bad('The platform owner account cannot be deleted');
    keepIfHeld(u.id, `The account ${u.username}`);
    // Their Drive can go to a colleague first (into a "Files from …" folder), instead of being deleted.
    let heir = null;
    if (req.query.transfer_to) {
      heir = q('SELECT id, name, org_id, disabled FROM users WHERE id = ?').get(String(req.query.transfer_to));
      if (!heir || heir.disabled || heir.org_id !== u.org_id || heir.id === u.id) throw bad('Choose someone else in the same company to give their files to');
    }
    // Their email from now on, and the meetings they organise, can go to a colleague too.
    const colleague = (id, what) => {
      if (!id) return null;
      const c = q('SELECT id, name, username, org_id, disabled FROM users WHERE id = ?').get(String(id));
      if (!c || c.disabled || c.org_id !== u.org_id || c.id === u.id) throw bad(`Choose someone else in the same company to give their ${what} to`);
      return c;
    };
    const mailHeir = colleague(req.query.mail_to, 'email');
    const eventsHeir = colleague(req.query.events_to, 'meetings');
    const kept = keepDriveFiles(u.id, heir?.id, req.user.id); // what they added to shared drives stays there
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
      // Upcoming meetings they organise (and repeating ones still going): the colleague becomes the organiser,
      // keeping the guests; past ones go with the account.
      if (eventsHeir) {
        const t = Date.now();
        const ids = q(`SELECT id FROM events WHERE owner_id = ? AND (end > ? OR (rrule IS NOT NULL AND (repeat_until IS NULL OR repeat_until > ?)))`).all(u.id, t, t).map((e) => e.id);
        for (const id of ids) {
          q('UPDATE events SET owner_id = ? WHERE id = ?').run(eventsHeir.id, id);
          q('DELETE FROM event_guests WHERE event_id = ? AND user_id = ?').run(id, eventsHeir.id); // the organiser isn't their own guest
        }
        req.eventsMoved = ids.length;
      }
      const list = blobsOwnedBy('?', u.id);
      q('UPDATE domains SET catchall = NULL WHERE catchall = (SELECT username FROM users WHERE id = ?)').run(u.id);
      // Their mail stays on the mail server; whoever gets this address next starts with an empty mailbox.
      retireMailHome(q('SELECT username, mail_home FROM users WHERE id = ?').get(u.id));
      q('DELETE FROM users WHERE id = ?').run(u.id);
      // Their address keeps working, into the colleague's inbox.
      if (mailHeir) q('INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), u.org_id, u.username, mailHeir.username, Date.now());
      fs.rmSync(photoFile(u.id), { force: true });
      return list;
    });
    removeBlobs(blobs);
    syncCompanyGroupAliases(u.org_id); // their groups' email addresses no longer include them
    scheduleMailConfig();
    audit(req, 'user.delete', { org: u.org_id, target: u.username, details: { ...(heir && { files_to: heir.name, items: req.moved }), ...(mailHeir && { mail_to: mailHeir.username }), ...(eventsHeir && { meetings_to: eventsHeir.name, meetings: req.eventsMoved }) } });
    res.json({ ok: true, files_moved: req.moved || 0, drive_items_kept: kept, mail_to: mailHeir?.username || null, meetings_moved: req.eventsMoved || 0 });
  });

  return r;
}
