// Company announcements: a short notice from an administrator ("Office closed Friday"), shown at the
// top of Workspace to everyone in the company (or one group of it) until they dismiss it or it ends; it can
// also wait to start at a set time. Mounted at /api/announcements.
import { Router } from 'express';
import { q } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { requireAdmin } from '../auth.js';
import { sendTo } from '../hub.js';
import { audit } from '../audit.js';

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
for (const [col, type] of [['starts_at', 'INTEGER'], ['group_id', 'TEXT REFERENCES groups(id) ON DELETE CASCADE']]) {
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

let lastTick = now();
/** Tell everyone's open Workspace when a scheduled announcement starts (checked each minute). */
export function announceStarted(t = now()) {
  const due = q('SELECT DISTINCT org_id FROM announcements WHERE starts_at > ? AND starts_at <= ?').all(lastTick, t);
  lastTick = t;
  for (const a of due) changed(a.org_id);
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
  r.post('/', requireAdmin, (req, res) => {
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
    const groupId = req.body.group_id ? String(req.body.group_id) : null;
    if (groupId && !q('SELECT 1 FROM groups WHERE id = ? AND org_id = ?').get(groupId, req.user.org_id)) throw bad('No such group');
    if (q('SELECT COUNT(*) AS n FROM announcements WHERE org_id = ? AND (until IS NULL OR until > ?)').get(req.user.org_id, now()).n >= MAX_LIVE) throw bad('Take an old announcement down first');
    const id = uid();
    q('INSERT INTO announcements (id, org_id, text, link, tone, author_id, created_at, until, starts_at, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.org_id, text, link, req.body.tone === 'warn' ? 'warn' : 'info', req.user.id, now(), until, startsAt, groupId);
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
