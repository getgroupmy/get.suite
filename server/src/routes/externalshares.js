// Admin → Shared outside: the company's files and folders shared with people at other companies
// (working across companies), who shared what with whom, and a way to stop one or all with a company.
import { Router } from 'express';
import { q } from '../db.js';
import { notFound, bad, uid } from '../util.js';
import { requireAdmin } from '../auth.js';
import { audit } from '../audit.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { csvCell } from '../csvcell.js';
import { sheetFromRows } from '../office/tablesheet.js';
import { insertFile } from './files.js';

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

// Undo for Stop: the share rows as they were, for a few minutes (key → { user, at, rows }).
const undos = new Map();
const UNDO_MS = 10 * 60e3;

/** Take shares away (rows from externalShares), telling each owner what went. → an Undo key. */
function stop(req, rows) {
  const byOwner = new Map();
  const saved = [];
  for (const r of rows) {
    const row = q('SELECT * FROM shares WHERE file_id = ? AND user_id = ?').get(r.file_id, r.user_id);
    if (row) saved.push({ row, owner_id: r.owner_id, file_name: r.file_name });
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
  const key = uid();
  undos.set(key, { user: req.user.id, org: req.user.org_id, at: Date.now(), saved });
  for (const [k, v] of undos) if (Date.now() - v.at > UNDO_MS) undos.delete(k);
  return key;
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
  // The same list as a spreadsheet, for an audit: a CSV to download, or a new spreadsheet of the admin's.
  const sharesTable = (orgId) => {
    const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
    const ROLE = { viewer: 'Can view', commenter: 'Can comment', editor: 'Can edit' };
    return [['File or folder', 'Kind', 'Shared by', 'Their email', 'With', 'Email', 'Company', 'Access', 'Until (UTC)', 'In the trash'],
      ...externalShares(orgId).map((x) => [x.file_name, x.kind, x.owner_name, x.owner_email, x.with_name, x.with_email, x.with_company, ROLE[x.role] || x.role, x.expires_at ? iso(x.expires_at) : '', x.trashed ? 'yes' : 'no'])];
  };
  r.get('/export.csv', (req, res) => {
    const table = sharesTable(req.user.org_id);
    audit(req, 'file.share_export', { details: { shares: table.length - 1 } });
    res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', 'attachment; filename="shared-outside.csv"').send(`\ufeff${table.map((r) => r.map((v) => csvCell(v)).join(',')).join('\r\n')}\r\n`);
  });
  r.post('/sheet', (req, res) => {
    const table = sharesTable(req.user.org_id);
    if (table.length < 2) throw bad('Nothing is shared outside the company');
    const json = JSON.stringify(sheetFromRows(table.map((r, i) => (i ? r.map((v) => String(v ?? '')) : r)), { header: true, name: 'Shared outside' }));
    const id = insertFile({ owner: req.user.id, parentId: null, name: `Shared outside ${new Date().toISOString().slice(0, 10)}`, kind: 'sheet', content: json, size: Buffer.byteLength(json) });
    audit(req, 'file.share_export', { details: { shares: table.length - 1, as: 'spreadsheet' } });
    res.status(201).json({ id, name: q('SELECT name FROM files WHERE id = ?').get(id).name, shares: table.length - 1 });
  });
  // The company's limit on outside shares (Company settings), applied to the shares that already exist:
  // each without an end, or ending later than the limit, now ends that many days from now. Owners are told.
  r.post('/enforce', (req, res) => {
    const days = q('SELECT external_share_days FROM orgs WHERE id = ?').get(req.user.org_id)?.external_share_days;
    if (!days) throw bad('Set a limit first (Company settings → Working with other companies)');
    const latest = Date.now() + days * 864e5;
    const rows = externalShares(req.user.org_id).filter((x) => x.expires_at === null || x.expires_at > latest);
    const byOwner = new Map();
    for (const x of rows) {
      q('UPDATE shares SET expires_at = ? WHERE file_id = ? AND user_id = ? AND direct_role IS NOT NULL').run(latest, x.file_id, x.user_id);
      if (!byOwner.has(x.owner_id)) byOwner.set(x.owner_id, new Set());
      byOwner.get(x.owner_id).add(x.file_name);
    }
    for (const [owner, names] of byOwner) {
      if (owner === req.user.id) continue;
      const list = [...names];
      bell([owner], { kind: 'share', title: `Your files shared outside the company now end in ${days} days`, body: `${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}: the company’s limit. Share again then if they still need it.`, link: '/drive/sharedbyme', actor: req.user.name });
    }
    audit(req, 'file.share', { target: `${rows.length} shares outside the company`, details: { limited_to_days: days } });
    res.json({ changed: rows.length, ends_at: latest });
  });

  // One share: DELETE /:fileId/:userId.
  r.delete('/:fileId/:userId', (req, res) => {
    const row = externalShares(req.user.org_id).find((x) => x.file_id === req.params.fileId && x.user_id === req.params.userId);
    if (!row) throw notFound('That share is gone already');
    const undo = stop(req, [row]);
    audit(req, 'file.share', { target: row.file_name, details: { removed: row.with_email, by_admin: true } });
    res.json({ stopped: 1, undo });
  });
  // Everything shared with one company's people: { org_id }.
  r.post('/stop-company', (req, res) => {
    const orgId = String(req.body?.org_id || '');
    if (!orgId) throw bad('Which company?');
    const rows = externalShares(req.user.org_id).filter((x) => x.with_org_id === orgId);
    if (!rows.length) throw notFound('Nothing is shared with that company');
    const undo = stop(req, rows);
    audit(req, 'file.share', { target: rows[0].with_company || 'Another company', details: { removed: rows.length, by_admin: true, company: true } });
    res.json({ stopped: rows.length, undo });
  });
  // Undo a Stop (within 10 minutes, by the admin who did it, once): those shares come back as they were,
  // unless their end came meanwhile; their owners are told.
  r.post('/undo', (req, res) => {
    const u = undos.get(String(req.body?.undo || ''));
    if (!u || u.user !== req.user.id || Date.now() - u.at > UNDO_MS) throw notFound('That can’t be undone any more');
    undos.delete(String(req.body.undo));
    let back = 0;
    const owners = new Map();
    for (const { row, owner_id, file_name } of u.saved) {
      if (row.expires_at && row.expires_at <= Date.now()) continue;
      if (!q('SELECT 1 FROM files WHERE id = ? AND owner_id = ?').get(row.file_id, owner_id) || !q('SELECT 1 FROM users WHERE id = ?').get(row.user_id)) continue;
      const cols = Object.keys(row);
      q(`INSERT OR REPLACE INTO shares (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      back++;
      sendTo([row.user_id, owner_id], { type: 'files-changed' });
      if (owner_id !== req.user.id) owners.set(owner_id, [...(owners.get(owner_id) || []), file_name]);
    }
    for (const [owner, names] of owners) bell([owner], { kind: 'share', title: `An admin put back sharing of ${names.length === 1 ? `“${names[0]}”` : `${names.length} of your files`} outside the company`, body: 'It was stopped by mistake.', link: '/drive/sharedbyme', actor: req.user.name });
    audit(req, 'file.share', { target: `${back} shares outside the company`, details: { restored: true } });
    res.json({ restored: back });
  });
  return r;
}
