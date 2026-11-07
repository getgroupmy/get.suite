// Company announcements: a short notice from an administrator ("Office closed Friday"), shown at the
// top of Workspace to everyone in the company until they dismiss it or it ends. Mounted at /api/announcements.
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
const MAX_LIVE = 20;

const everyone = (orgId) => q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(orgId).map((u) => u.id);
const changed = (orgId) => sendTo(everyone(orgId), { type: 'announcements-changed' });
const live = (orgId, t = now()) => q(`SELECT a.*, u.name AS author_name FROM announcements a LEFT JOIN users u ON u.id = a.author_id
                                      WHERE a.org_id = ? AND (a.until IS NULL OR a.until > ?) ORDER BY a.created_at DESC`).all(orgId, t);

export default function announcementRoutes() {
  const r = Router();
  // Yours to see: the company's current ones you haven't dismissed.
  r.get('/', (req, res) => {
    const gone = new Set(q('SELECT announcement_id FROM announcement_dismissals WHERE user_id = ?').all(req.user.id).map((d) => d.announcement_id));
    res.json(live(req.user.org_id).filter((a) => !gone.has(a.id)));
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
    if (q('SELECT COUNT(*) AS n FROM announcements WHERE org_id = ? AND (until IS NULL OR until > ?)').get(req.user.org_id, now()).n >= MAX_LIVE) throw bad('Take an old announcement down first');
    const id = uid();
    q('INSERT INTO announcements (id, org_id, text, link, tone, author_id, created_at, until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.org_id, text, link, req.body.tone === 'warn' ? 'warn' : 'info', req.user.id, now(), until);
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
