// Approvals: ask colleagues to approve a file (a contract, a press release, a budget). Each reviewer
// approves or rejects it, with a comment if they like. The file shows Pending, Approved (everyone
// approved) or Rejected (anyone rejected), and changes made after it was approved are flagged.
// Mounted at /api/approvals.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { roleFor, atLeast } from '../access.js';
import { canReach } from '../tenancy.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { recordActivity } from '../fileactivity.js';

q(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL DEFAULT '',
  due TEXT,                         -- YYYY-MM-DD, optional
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  version_at INTEGER                -- the file's updated_at when it was asked for
)`).run();
q(`CREATE TABLE IF NOT EXISTS approval_reviewers (
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT,                    -- null (waiting) | approved | rejected
  comment TEXT,
  decided_at INTEGER,
  PRIMARY KEY (approval_id, user_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS approvals_file ON approvals(file_id, created_at)').run();

const MAX_REVIEWERS = 20;
const LINK = { doc: (f) => `/docs/${f.id}`, sheet: (f) => `/sheets/${f.id}`, slides: (f) => `/slides/${f.id}` };
const linkOf = (f) => (LINK[f.kind] ? LINK[f.kind](f) : `/drive/approvals`);

/** An approval with its reviewers, and whether the file has changed since it was decided. */
export function describe(a) {
  if (!a) return null;
  const f = q('SELECT id, name, kind, updated_at FROM files WHERE id = ?').get(a.file_id);
  const reviewers = q(`SELECT r.user_id AS id, u.name, u.username, r.decision, r.comment, r.decided_at FROM approval_reviewers r JOIN users u ON u.id = r.user_id
                       WHERE r.approval_id = ? ORDER BY u.name`).all(a.id);
  const by = q('SELECT id, name FROM users WHERE id = ?').get(a.requested_by);
  return { id: a.id, file: f, message: a.message, due: a.due, status: a.status, created_at: a.created_at, decided_at: a.decided_at,
    requested_by: by, reviewers, changed_since: a.status === 'approved' && f && a.decided_at && f.updated_at > a.decided_at };
}
/** The latest approval of a file (any status but cancelled). */
export const latestFor = (fileId) => describe(q("SELECT * FROM approvals WHERE file_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1").get(fileId));

function loadFile(id, user) {
  const f = q('SELECT * FROM files WHERE id = ? AND trashed = 0').get(String(id));
  const role = f && roleFor(f.id, user.id);
  if (!role || f.kind === 'folder') throw notFound('File not found');
  return { f, role };
}
const everyone = (a) => [a.requested_by, ...q('SELECT user_id FROM approval_reviewers WHERE approval_id = ?').all(a.id).map((r) => r.user_id)].filter(Boolean);
const tell = (a) => sendTo(everyone(a), { type: 'approvals-changed', file_id: a.file_id });

export default function approvalRoutes() {
  const r = Router();

  // The file's current approval and its history.
  r.get('/file/:fileId', (req, res) => {
    const { f } = loadFile(req.params.fileId, req.user);
    res.json({ current: latestFor(f.id), history: q('SELECT * FROM approvals WHERE file_id = ? ORDER BY created_at DESC LIMIT 20').all(f.id).map(describe) });
  });

  // Waiting for you, and what you asked for.
  r.get('/', (req, res) => {
    const forMe = q(`SELECT a.* FROM approvals a JOIN approval_reviewers r ON r.approval_id = a.id
                     WHERE r.user_id = ? AND a.status = 'pending' AND r.decision IS NULL ORDER BY a.created_at DESC`).all(req.user.id);
    const mine = q("SELECT * FROM approvals WHERE requested_by = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 50").all(req.user.id);
    res.json({ waiting: forMe.map(describe).filter((a) => a.file), requested: mine.map(describe).filter((a) => a.file) });
  });

  // Ask for approval: { file_id, reviewers: [user ids], message, due }.
  r.post('/', (req, res) => {
    const { f, role } = loadFile(req.body?.file_id, req.user);
    if (!atLeast(role, 'editor')) throw forbidden('Only people who can edit the file can ask for approval');
    const ids = Array.isArray(req.body?.reviewers) ? [...new Set(req.body.reviewers.map(String))].filter((x) => x !== req.user.id) : [];
    if (!ids.length) throw bad('Choose at least one reviewer');
    if (ids.length > MAX_REVIEWERS) throw bad(`Up to ${MAX_REVIEWERS} reviewers`);
    for (const id of ids) {
      if (!canReach(req.user, id)) throw bad('You can only ask colleagues you can share with');
      if (!roleFor(f.id, id)) throw bad(`${q('SELECT name FROM users WHERE id = ?').get(id)?.name || 'A reviewer'} can't open this file yet. Share it with them first.`);
    }
    const due = req.body?.due ? String(req.body.due) : null;
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw bad('Bad due date');
    const id = uid(), t = now();
    tx(() => {
      // A new request replaces one still waiting.
      q("UPDATE approvals SET status = 'cancelled' WHERE file_id = ? AND status = 'pending'").run(f.id);
      q('INSERT INTO approvals (id, file_id, requested_by, message, due, status, created_at, version_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, f.id, req.user.id, str(req.body?.message ?? '', { max: 1000 }) || '', due, 'pending', t, f.updated_at);
      for (const u of ids) q('INSERT INTO approval_reviewers (approval_id, user_id) VALUES (?, ?)').run(id, u);
    });
    recordActivity(f.id, req.user.id, 'approval', { asked: ids.map((x) => q('SELECT name FROM users WHERE id = ?').get(x)?.name) });
    bell(ids, { kind: 'share', title: `${req.user.name} asked you to approve “${f.name}”`, body: req.body?.message ? String(req.body.message).slice(0, 200) : (due ? `By ${due}` : null), link: linkOf(f), actor: req.user.name });
    const a = q('SELECT * FROM approvals WHERE id = ?').get(id);
    tell(a);
    res.status(201).json(describe(a));
  });

  // Approve or reject: { decision: 'approved' | 'rejected', comment }.
  r.post('/:id/decide', (req, res) => {
    const a = q('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!a) throw notFound('Approval not found');
    const me = q('SELECT * FROM approval_reviewers WHERE approval_id = ? AND user_id = ?').get(a.id, req.user.id);
    if (!me) throw forbidden('You are not a reviewer of this');
    if (a.status !== 'pending') throw bad('This approval is already finished');
    const decision = ['approved', 'rejected'].includes(req.body?.decision) ? req.body.decision : null;
    if (!decision) throw bad('decision must be approved or rejected');
    const comment = str(req.body?.comment ?? '', { max: 1000 }) || null;
    const t = now();
    const f = q('SELECT * FROM files WHERE id = ?').get(a.file_id);
    tx(() => {
      q('UPDATE approval_reviewers SET decision = ?, comment = ?, decided_at = ? WHERE approval_id = ? AND user_id = ?').run(decision, comment, t, a.id, req.user.id);
      const left = q('SELECT COUNT(*) AS n FROM approval_reviewers WHERE approval_id = ? AND decision IS NULL').get(a.id).n;
      const status = decision === 'rejected' ? 'rejected' : left === 0 ? 'approved' : 'pending';
      if (status !== 'pending') q('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(status, t, a.id);
    });
    const after = q('SELECT * FROM approvals WHERE id = ?').get(a.id);
    recordActivity(a.file_id, req.user.id, 'approval', { decision, ...(comment && { comment }) });
    const word = decision === 'approved' ? 'approved' : 'rejected';
    const others = everyone(a).filter((x) => x !== req.user.id);
    bell(others, { kind: 'share', title: after.status === 'approved' ? `“${f.name}” is approved` : `${req.user.name} ${word} “${f.name}”`, body: comment, link: linkOf(f), actor: req.user.name });
    tell(after);
    res.json(describe(after));
  });

  // The person who asked can cancel it while it's waiting.
  r.post('/:id/cancel', (req, res) => {
    const a = q('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
    if (!a) throw notFound('Approval not found');
    if (a.requested_by !== req.user.id) throw forbidden('Only the person who asked can cancel it');
    if (a.status !== 'pending') throw bad('This approval is already finished');
    q("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ?").run(now(), a.id);
    tell(a);
    res.json({ ok: true });
  });

  return r;
}
