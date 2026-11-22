// The activity log for company admins (the platform owner can look at any company). Newest first,
// a page at a time, or all of it as CSV. Mounted at /api/audit.
import { Router } from 'express';
import { q, fold } from '../db.js';
import { requireAdmin } from '../auth.js';
import { bad } from '../util.js';
import { ACTIONS } from '../audit.js';
import { csvCell } from '../csvcell.js';
import { sheetFromRows } from '../office/tablesheet.js';
import { insertFile } from './files.js';

const csv = (v) => csvCell(v); // (csvcell.js: quoted as needed, kept from running as a formula)

export default function auditRoutes() {
  const r = Router();
  r.use(requireAdmin);

  const query = (req) => {
    const org = req.query.org_id && req.user.is_super ? String(req.query.org_id) : req.user.org_id;
    const where = ['org_id = ?'];
    const args = [org];
    if (req.query.action) {
      const acts = String(req.query.action).split(',').filter((a) => ACTIONS[a] || Object.keys(ACTIONS).some((k) => k.startsWith(`${a}.`) || k === a));
      if (!acts.length) throw bad('Unknown kind of activity');
      // "user" means every user.* action; "sign-in" includes failed ones.
      where.push(`(${acts.map(() => '(action = ? OR action LIKE ?)').join(' OR ')})`);
      for (const a of acts) args.push(a, `${a}.%`);
    }
    if (req.query.q) {
      const like = `%${fold(String(req.query.q)).replace(/[%_!]/g, (c) => `!${c}`)}%`; // (accents don't matter)
      where.push("(fold(COALESCE(actor_name, '')) LIKE ? ESCAPE '!' OR fold(COALESCE(target, '')) LIKE ? ESCAPE '!' OR COALESCE(ip, '') LIKE ? ESCAPE '!')");
      args.push(like, like, like);
    }
    if (req.query.from) { where.push('at >= ?'); args.push(Number(req.query.from)); }
    if (req.query.to) { where.push('at < ?'); args.push(Number(req.query.to)); }
    return { where: where.join(' AND '), args };
  };
  const shape = (e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null, label: ACTIONS[e.action] || e.action });

  r.get('/', (req, res) => {
    const { where, args } = query(req);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = q(`SELECT * FROM audit_log WHERE ${where} AND id < ? ORDER BY id DESC LIMIT 101`).all(...args, before);
    res.json({ entries: rows.slice(0, 100).map(shape), more: rows.length > 100, actions: ACTIONS });
  });

  const HEAD = ['Time (UTC)', 'Who', 'What', 'Target', 'Details', 'IP address'];
  const line = (e, time) => [time(e.at), e.actor_name || '', ACTIONS[e.action] || e.action, e.target || '', e.details || '', e.ip || ''];
  r.get('/export', (req, res) => {
    const { where, args } = query(req);
    const rows = q(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 100000`).all(...args);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity.csv"');
    res.send(`\ufeff${[HEAD.join(','), ...rows.map((e) => line(e, (t) => new Date(t).toISOString()).map(csv).join(','))].join('\r\n')}\r\n`);
  });
  // Open in Sheets: what the log shows (the same filters) as a new spreadsheet in the admin's Drive, newest first, the
  // latest 20,000; the heading row bold and kept in view, to sort and filter there.
  r.post('/sheet', (req, res) => {
    const { where, args } = query(req);
    const rows = q(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 20000`).all(...args);
    if (!rows.length) throw bad('There is nothing in the activity log for these filters');
    const table = [HEAD, ...rows.map((e) => line(e, (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')).map((v, c) => (c === 0 ? v : String(v))))];
    const json = JSON.stringify(sheetFromRows(table, { header: true, name: 'Activity' }));
    const id = insertFile({ owner: req.user.id, parentId: null, name: `Activity log ${new Date().toISOString().slice(0, 10)}`, kind: 'sheet', content: json, size: Buffer.byteLength(json) });
    res.status(201).json({ id, name: q('SELECT name FROM files WHERE id = ?').get(id).name, entries: rows.length });
  });
  return r;
}
