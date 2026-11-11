// Company announcements: a short notice from an administrator ("Office closed Friday"), shown at the
// top of Workspace to everyone in the company (or one group of it) until they dismiss it or it ends; it can
// also wait to start at a set time. Mounted at /api/announcements.
import { Router } from 'express';
import { q } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { requireAdmin } from '../auth.js';
import { sendTo } from '../hub.js';
import { audit } from '../audit.js';
import { mailEnabled } from '../mail/config.js';
import { smtpFor } from '../mail/imap.js';

q(`CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  link TEXT,
  tone TEXT NOT NULL DEFAULT 'info',     -- info | warn
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  until INTEGER                            -- null: until taken down
)`).run();
q(`CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
)`).run();
// starts_at: shown from then (null: straight away); group_id: only for that group's members (null: everyone).
// email: also sent by email to the people it's for (when it starts), from its author; emailed_at/emailed_to: when, and to how many.
// base: the address Workspace was used at, for links to its pages in the email.
for (const [col, type] of [['starts_at', 'INTEGER'], ['group_id', 'TEXT REFERENCES groups(id) ON DELETE CASCADE'], ['email', 'INTEGER NOT NULL DEFAULT 0'], ['emailed_at', 'INTEGER'], ['emailed_to', 'INTEGER'], ['base', 'TEXT']]) {
  if (!q('PRAGMA table_info(announcements)').all().some((c) => c.name === col)) q(`ALTER TABLE announcements ADD COLUMN ${col} ${type}`).run();
}
const MAX_LIVE = 20;

const everyone = (orgId) => q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(orgId).map((u) => u.id);
const changed = (orgId) => sendTo(everyone(orgId), { type: 'announcements-changed' });
/** Not ended yet (started or still to come), newest first, with the group's name and size. */
const live = (orgId, t = now()) => q(`SELECT a.*, u.name AS author_name, g.name AS group_name,
                                        (SELECT COUNT(*) FROM group_members m JOIN users gu ON gu.id = m.user_id WHERE m.group_id = a.group_id AND gu.disabled = 0) AS group_size
                                      FROM announcements a LEFT JOIN users u ON u.id = a.author_id LEFT JOIN groups g ON g.id = a.group_id
                                      WHERE a.org_id = ? AND (a.until IS NULL OR a.until > ?) ORDER BY COALESCE(a.starts_at, a.created_at) DESC`).all(orgId, t);
/** Those someone sees now: started, and for everyone or for a group they're in. */
export function showingTo(userId, orgId, t = now()) {
  const mine = new Set(q('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).map((m) => m.group_id));
  const gone = new Set(q('SELECT announcement_id FROM announcement_dismissals WHERE user_id = ?').all(userId).map((d) => d.announcement_id));
  return live(orgId, t).filter((a) => (!a.starts_at || a.starts_at <= t) && (!a.group_id || mine.has(a.group_id)) && !gone.has(a.id));
}

/** The addresses of the people an announcement is for: the company's active people, or its group's. */
export function audienceOf(a) {
  return (a.group_id
    ? q('SELECT u.username FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.disabled = 0 ORDER BY u.username').all(a.group_id)
    : q('SELECT username FROM users WHERE org_id = ? AND disabled = 0 ORDER BY username').all(a.org_id)).map((u) => u.username);
}
/** The email for an announcement: its subject and text, with its link made whole. */
export function announcementMail(a, { author, org, group } = {}) {
  const link = a.link ? (a.link.startsWith('/') ? `${(a.base || '').replace(/\/$/, '')}${a.link}` : a.link) : null;
  const subject = `${a.tone === 'warn' ? 'Important: ' : 'Announcement: '}${a.text.length > 70 ? `${a.text.slice(0, 67)}…` : a.text}`;
  const lines = [a.text, ...(link ? ['', link] : []), '', `— ${author || 'Your administrator'}, to ${group ? `the ${group} group` : `everyone at ${org || 'the company'}`}. It's also shown at the top of Workspace.`];
  return { subject, text: lines.join('\n') };
}
const MAIL_BATCH = 50; // recipients per message, all as Bcc
/** Send an announcement by email from its author (once). Returns how many it went to. */
export async function emailAnnouncement(id) {
  const a = q('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!a || !a.email || a.emailed_at || !mailEnabled()) return 0;
  const author = q('SELECT id, username, name, disabled FROM users WHERE id = ?').get(a.author_id);
  if (!author || author.disabled) return 0;
  q('UPDATE announcements SET emailed_at = ? WHERE id = ?').run(now(), a.id); // once, even if sending fails part-way
  const to = audienceOf(a);
  const org = q('SELECT name FROM orgs WHERE id = ?').get(a.org_id)?.name;
  const group = a.group_id ? q('SELECT name FROM groups WHERE id = ?').get(a.group_id)?.name : null;
  const { subject, text } = announcementMail(a, { author: author.name, org, group });
  let sent = 0;
  for (let i = 0; i < to.length; i += MAIL_BATCH) {
    const bcc = to.slice(i, i + MAIL_BATCH);
    try {
      const info = await smtpFor(author).sendMail({ from: { name: author.name, address: author.username }, to: { name: group || org || 'Everyone', address: author.username }, bcc, subject, text });
      const took = new Set((info.accepted || []).map((x) => String(x.address || x).toLowerCase()));
      sent += bcc.filter((x) => took.has(x.toLowerCase())).length; // only those the mail server took
    } catch (e) { console.error('[announcements] email:', e.message); }
  }
  // Nobody took it (the mail server unreachable, say): try again at the next minute's check.
  if (!sent && to.length) q('UPDATE announcements SET emailed_at = NULL WHERE id = ?').run(a.id);
  else q('UPDATE announcements SET emailed_to = ? WHERE id = ?').run(sent, a.id);
  return sent;
}

let lastTick = now();
/** Tell everyone's open Workspace when a scheduled announcement starts (checked each minute). */
export function announceStarted(t = now()) {
  const due = q('SELECT DISTINCT org_id FROM announcements WHERE starts_at > ? AND starts_at <= ?').all(lastTick, t);
  lastTick = t;
  for (const a of due) changed(a.org_id);
  // Those to email that have started (now, or while the server was off).
  for (const a of q('SELECT id FROM announcements WHERE email = 1 AND emailed_at IS NULL AND COALESCE(starts_at, created_at) <= ? AND (until IS NULL OR until > ?)').all(t, t)) {
    emailAnnouncement(a.id).catch((e) => console.error('[announcements]', e.message));
  }
  return due.length;
}
export function scheduleAnnouncementStarts() { setInterval(() => announceStarted(), 60e3).unref(); }

export default function announcementRoutes() {
  const r = Router();
  // Yours to see: the company's current ones you haven't dismissed.
  r.get('/', (req, res) => {
    res.json(showingTo(req.user.id, req.user.org_id));
  });
  r.post('/:id/dismiss', (req, res) => {
    const a = q('SELECT id FROM announcements WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!a) throw notFound();
    q('INSERT OR IGNORE INTO announcement_dismissals (announcement_id, user_id) VALUES (?, ?)').run(a.id, req.user.id);
    sendTo([req.user.id], { type: 'announcements-changed' });
    res.json({ ok: true });
  });

  // Administrators: all current ones (with how many dismissed), post one, take one down.
  r.get('/all', requireAdmin, (req, res) => {
    res.json(live(req.user.org_id).map((a) => ({ ...a, dismissed: q('SELECT COUNT(*) AS n FROM announcement_dismissals WHERE announcement_id = ?').get(a.id).n })));
  });
  r.post('/', requireAdmin, async (req, res) => {
    const text = str(req.body.text, { required: true, name: 'Announcement', max: 300 });
    const link = req.body.link ? String(req.body.link).trim() : null;
    if (link && (!/^(https?:\/\/|\/)/i.test(link) || link.startsWith('//') || link.length > 500)) throw bad('Links start with https:// or with / for a page in Workspace');
    let until = req.body.until == null ? null : Number(req.body.until);
    if (until !== null && (!Number.isFinite(until) || until <= now())) throw bad('Pick an end in the future');
    let startsAt = req.body.starts_at == null || req.body.starts_at === '' ? null : Number(req.body.starts_at);
    if (startsAt !== null && !Number.isFinite(startsAt)) throw bad('starts_at must be a time');
    if (startsAt !== null && startsAt <= now()) startsAt = null; // already: straight away
    if (startsAt !== null && startsAt > now() + 366 * 864e5) throw bad('Start it within a year');
    if (startsAt !== null && until !== null && until <= startsAt) throw bad('It has to end after it starts');
    const email = !!req.body.email;
    if (email && !mailEnabled()) throw bad('This server has no email');
    const groupId = req.body.group_id ? String(req.body.group_id) : null;
    if (groupId && !q('SELECT 1 FROM groups WHERE id = ? AND org_id = ?').get(groupId, req.user.org_id)) throw bad('No such group');
    if (q('SELECT COUNT(*) AS n FROM announcements WHERE org_id = ? AND (until IS NULL OR until > ?)').get(req.user.org_id, now()).n >= MAX_LIVE) throw bad('Take an old announcement down first');
    const id = uid();
    q('INSERT INTO announcements (id, org_id, text, link, tone, author_id, created_at, until, starts_at, group_id, email, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.org_id, text, link, req.body.tone === 'warn' ? 'warn' : 'info', req.user.id, now(), until, startsAt, groupId, email ? 1 : 0,
        process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`);
    if (email && !startsAt) await emailAnnouncement(id); // a scheduled one goes when it starts
    audit(req, 'announcement.post', { org: req.user.org_id, target: text.slice(0, 80) });
    changed(req.user.org_id);
    res.status(201).json(q('SELECT * FROM announcements WHERE id = ?').get(id));
  });
  r.delete('/:id', requireAdmin, (req, res) => {
    const a = q('SELECT * FROM announcements WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
    if (!a) throw notFound();
    q('DELETE FROM announcements WHERE id = ?').run(a.id);
    audit(req, 'announcement.remove', { org: req.user.org_id, target: a.text.slice(0, 80) });
    changed(req.user.org_id);
    res.json({ ok: true });
  });
  return r;
}
