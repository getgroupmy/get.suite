// The activity log for company admins (the platform owner can look at any company). Newest first,
// a page at a time, or all of it as CSV. Mounted at /api/audit.
import { Router } from 'express';
import { q } from '../db.js';
import { requireAdmin } from '../auth.js';
import { bad } from '../util.js';
import { ACTIONS } from '../audit.js';

const csv = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

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
      const like = `%${String(req.query.q).toLowerCase().replace(/[%_!]/g, (c) => `!${c}`)}%`;
      where.push("(LOWER(COALESCE(actor_name, '')) LIKE ? ESCAPE '!' OR LOWER(COALESCE(target, '')) LIKE ? ESCAPE '!' OR COALESCE(ip, '') LIKE ? ESCAPE '!')");
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

  r.get('/export', (req, res) => {
    const { where, args } = query(req);
    const rows = q(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 100000`).all(...args);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity.csv"');
    res.send(`﻿${[['Time (UTC)', 'Who', 'What', 'Target', 'Details', 'IP address'].join(','),
      ...rows.map((e) => [new Date(e.at).toISOString(), e.actor_name || '', ACTIONS[e.action] || e.action, e.target || '', e.details || '', e.ip || ''].map(csv).join(','))].join('\r\n')}\r\n`);
  });
  return r;
}
