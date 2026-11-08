// Publish to the web: a document, spreadsheet or presentation as a read-only page anyone with its
// address can see (/pub/<token>), always showing the latest version. Only the owner publishes or
// stops publishing; it follows the company's "links for people without an account" switch, and
// stops when the file goes to the trash or the owner's account is turned off. Speaker notes,
// comments and suggestions that haven't been accepted aren't shown.
import { Router } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { q, FILES_DIR } from '../db.js';
import { now, bad, notFound, forbidden } from '../util.js';
import { roleFor, atLeast } from '../access.js';
import { audit } from '../audit.js';
import { picturesIn } from './files.js';
import { withoutSuggestions } from '../office/suggestions.js';
import { saveNow, CO_EDITED } from '../collab.js';

q(`CREATE TABLE IF NOT EXISTS published_files (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0
)`).run();
const KINDS = ['doc', 'sheet', 'slides'];
// A company can turn publishing off on its own (Admin → Company settings); pages already published stop showing.
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'allow_publish')) q('ALTER TABLE orgs ADD COLUMN allow_publish INTEGER NOT NULL DEFAULT 1').run();

/** The owner's controls: GET /api/publish/:fileId, PUT { on: true | false }. */
export function publishRoutes() {
  const r = Router();
  const own = (req) => {
    const f = q('SELECT f.*, u.org_id FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ? AND f.trashed = 0').get(String(req.params.fileId));
    if (!f || !roleFor(f.id, req.user.id)) throw notFound('File not found');
    if (!KINDS.includes(f.kind)) throw bad('Documents, spreadsheets and presentations can be published');
    return f;
  };
  const out = (f) => { const p = q('SELECT token, created_at, views FROM published_files WHERE file_id = ?').get(f.id); return p ? { published: true, path: `/pub/${p.token}`, since: p.created_at, views: p.views } : { published: false }; };
  // Admins: everything the company has published (to review, or stop).
  r.get('/', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins see this');
    res.json(q(`SELECT p.file_id, p.token, p.created_at, p.views, f.name, f.kind, u.name AS owner_name FROM published_files p JOIN files f ON f.id = p.file_id JOIN users u ON u.id = f.owner_id
                WHERE u.org_id = ? AND f.trashed = 0 ORDER BY p.created_at DESC`).all(req.user.org_id).map(({ token, ...x }) => ({ ...x, path: `/pub/${token}` })));
  });
  r.delete('/:fileId', (req, res) => {
    if (!req.user.is_admin) throw forbidden('Only admins can stop someone else’s published page');
    const p = q(`SELECT p.file_id, f.name FROM published_files p JOIN files f ON f.id = p.file_id JOIN users u ON u.id = f.owner_id WHERE p.file_id = ? AND u.org_id = ?`).get(String(req.params.fileId), req.user.org_id);
    if (!p) throw notFound();
    q('DELETE FROM published_files WHERE file_id = ?').run(p.file_id);
    audit(req, 'file.unpublish', { target: p.name, details: { by_admin: true } });
    res.json({ ok: true });
  });
  r.get('/:fileId', (req, res) => res.json(out(own(req))));
  r.put('/:fileId', (req, res) => {
    const f = own(req);
    if (f.owner_id !== req.user.id) throw forbidden('Only the owner can publish it');
    if (req.body?.on) {
      const org = q('SELECT allow_links, allow_publish FROM orgs WHERE id = ?').get(f.org_id);
      if (!org?.allow_links) throw forbidden('Your company has turned off sharing with people who have no account');
      if (!org.allow_publish) throw forbidden('Your company has turned off publishing to the web');
      if (!q('SELECT 1 FROM published_files WHERE file_id = ?').get(f.id)) {
        q('INSERT INTO published_files (file_id, token, created_by, created_at) VALUES (?, ?, ?, ?)').run(f.id, crypto.randomBytes(18).toString('base64url'), req.user.id, now());
        audit(req, 'file.publish', { target: f.name });
      }
    } else if (q('DELETE FROM published_files WHERE file_id = ?').run(f.id).changes) audit(req, 'file.unpublish', { target: f.name });
    res.json(out(f));
  });
  return r;
}

/** What's published there, if it still may be seen. */
function published(token) {
  const p = q(`SELECT p.*, f.name, f.kind, f.updated_at, f.trashed, f.owner_id, u.disabled, o.allow_links, o.allow_publish, o.name AS org_name
               FROM published_files p JOIN files f ON f.id = p.file_id JOIN users u ON u.id = f.owner_id JOIN orgs o ON o.id = u.org_id
               WHERE p.token = ?`).get(String(token));
  if (!p || p.trashed || p.disabled || !p.allow_links || !p.allow_publish) throw notFound('Nothing is published at this address (any more)');
  return p;
}

/** The public side: /api/public/pub/:token (and its pictures). */
export function publicPublishRoutes() {
  const r = Router();
  r.get('/:token', (req, res) => {
    const p = published(req.params.token);
    if (CO_EDITED.includes(p.kind)) saveNow(p.file_id); // what's being typed right now
    let content = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(p.file_id).content || 'null');
    if (p.kind === 'doc') content = withoutSuggestions(content);
    if (p.kind === 'slides') content = { ...content, slides: (content?.slides || []).filter((s) => !s.skip).map(({ notes, ...s }) => s) }; // no speaker notes, no skipped slides
    if (p.kind === 'sheet') content = { sheets: (content?.sheets || []).filter((s) => !s.hidden).map((s) => ({ name: s.name, cells: s.cells || {}, formats: s.formats || {}, widths: s.widths || s.colWidths || {}, merges: s.merges || [] })), names: content?.names || null };
    if (!req.query.peek) q('UPDATE published_files SET views = views + 1 WHERE file_id = ?').run(p.file_id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.json({ name: p.name, kind: p.kind, org_name: p.org_name, updated_at: p.updated_at, content });
  });
  // Pictures the published document or presentation shows (owned by someone who can edit it, as in the editor).
  r.get('/:token/pictures/:pic', (req, res) => {
    const p = published(req.params.token);
    const content = JSON.parse(q('SELECT content FROM files WHERE id = ?').get(p.file_id).content || '{}');
    const pic = String(req.params.pic);
    if (!picturesIn(p.kind, content).has(pic)) throw notFound('Picture not found');
    const f = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(pic);
    if (!f || !/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mime || '') || !atLeast(roleFor(p.file_id, f.owner_id) || '', 'editor')) throw notFound('Picture not found');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'public, max-age=300' } });
  });
  return r;
}
