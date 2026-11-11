// Audience Q&A while presenting: whoever presents a presentation (anyone who can edit it) starts a session,
// with a short code. People at the company open /qa/<code>, ask questions (with their name, or without)
// and upvote others'. The presenter sees them, most upvoted first, and marks them answered. The page and
// the presenter ask again every few seconds, so nothing needs to stay connected.
import { Router } from 'express';
import crypto from 'node:crypto';
import { q } from '../db.js';
import { uid, now, str, notFound, bad, forbidden } from '../util.js';
import { roleFor, atLeast } from '../access.js';

q(`CREATE TABLE IF NOT EXISTS slide_qa (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
)`).run();
q(`CREATE TABLE IF NOT EXISTS slide_qa_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES slide_qa(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
)`).run();
q(`CREATE TABLE IF NOT EXISTS slide_qa_votes (
  question_id TEXT NOT NULL REFERENCES slide_qa_questions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, user_id)
)`).run();

export const MAX_QUESTIONS = 300; // per session
export const MAX_PER_PERSON = 20;
const LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i

/** A short code people can type: 6 characters. */
export function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), (b) => LETTERS[b % LETTERS.length]).join('');
    if (!q('SELECT 1 FROM slide_qa WHERE code = ?').get(code)) return code;
  }
}

/** Questions as people see them: open ones first, most upvoted first, then oldest; answered ones after. */
export function orderQuestions(list) {
  return [...list].sort((a, b) => (!!a.answered - !!b.answered) || (b.votes - a.votes) || (a.created_at - b.created_at));
}

const deckFor = (fileId, user, needed) => {
  const f = q("SELECT id, name, kind, trashed FROM files WHERE id = ?").get(String(fileId));
  const role = f && !f.trashed ? roleFor(f.id, user.id) : null;
  if (!f || f.kind !== 'slides' || !role) throw notFound('Presentation not found');
  if (needed && !atLeast(role, needed)) throw forbidden('Only people who can edit the presentation run its Q&A');
  return { ...f, role };
};
const sessionFor = (code, user) => {
  const s = q('SELECT * FROM slide_qa WHERE code = ?').get(String(code || '').toLowerCase());
  if (!s || s.org_id !== user.org_id) throw notFound('No Q&A with that code');
  return s;
};
const mayRun = (s, user) => s.started_by === user.id || atLeast(roleFor(s.file_id, user.id) || '', 'editor');

function view(s, user) {
  const rows = q(`SELECT k.*, u.name AS user_name, (SELECT COUNT(*) FROM slide_qa_votes v WHERE v.question_id = k.id) AS votes,
                    EXISTS (SELECT 1 FROM slide_qa_votes v WHERE v.question_id = k.id AND v.user_id = ?) AS voted
                  FROM slide_qa_questions k LEFT JOIN users u ON u.id = k.user_id WHERE k.session_id = ?`).all(user.id, s.id);
  const runs = mayRun(s, user);
  return {
    code: s.code, title: q('SELECT name FROM files WHERE id = ?').get(s.file_id)?.name || 'Presentation',
    presenter: q('SELECT name FROM users WHERE id = ?').get(s.started_by)?.name || null,
    open: !s.ended_at, runs,
    questions: orderQuestions(rows.map((k) => ({
      id: k.id, body: k.body, created_at: k.created_at, votes: k.votes, voted: !!k.voted, answered: !!k.answered_at,
      mine: k.user_id === user.id, who: k.anonymous ? null : (k.user_name || 'Someone'),
    }))),
  };
}

// Rehearsals: run through a presentation timing each slide; each person keeps their last few for a deck.
q(`CREATE TABLE IF NOT EXISTS slide_rehearsals (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  slides TEXT NOT NULL
)`).run();
export const KEEP_REHEARSALS = 5;
const rehearsalOut = (x) => ({ id: x.id, at: x.at, total_ms: x.total_ms, slides: JSON.parse(x.slides) });

export default function slideQaRoutes() {
  const r = Router();

  // Your rehearsals of a deck, newest first.
  r.get('/rehearsals/:fileId', (req, res) => {
    const f = deckFor(req.params.fileId, req.user);
    res.json(q('SELECT * FROM slide_rehearsals WHERE file_id = ? AND user_id = ? ORDER BY at DESC').all(f.id, req.user.id).map(rehearsalOut));
  });
  // Keep one: { slides: [{ i, ms }] } (time on each slide shown). Only the last few are kept.
  r.post('/rehearsals/:fileId', (req, res) => {
    const f = deckFor(req.params.fileId, req.user);
    const list = (Array.isArray(req.body?.slides) ? req.body.slides : []).map((x) => ({ i: Number(x?.i), ms: Math.round(Number(x?.ms)) }))
      .filter((x) => Number.isInteger(x.i) && x.i >= 0 && x.i < 1000 && Number.isFinite(x.ms) && x.ms > 0 && x.ms < 24 * 36e5);
    if (!list.length) throw bad('Nothing was timed');
    const byI = new Map();
    for (const x of list) byI.set(x.i, (byI.get(x.i) || 0) + x.ms); // back to a slide: its times add up
    const slides = [...byI].map(([i, ms]) => ({ i, ms })).sort((a, b) => a.i - b.i);
    const row = { id: uid(), file_id: f.id, user_id: req.user.id, at: now(), total_ms: slides.reduce((n, x) => n + x.ms, 0), slides: JSON.stringify(slides) };
    q('INSERT INTO slide_rehearsals (id, file_id, user_id, at, total_ms, slides) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.file_id, row.user_id, row.at, row.total_ms, row.slides);
    q(`DELETE FROM slide_rehearsals WHERE file_id = ? AND user_id = ? AND id NOT IN (SELECT id FROM slide_rehearsals WHERE file_id = ? AND user_id = ? ORDER BY at DESC LIMIT ${KEEP_REHEARSALS})`).run(f.id, req.user.id, f.id, req.user.id);
    res.status(201).json(rehearsalOut(row));
  });

  // For the presenter: the session running for a presentation (or none), and starting or ending one.
  r.get('/decks/:fileId', (req, res) => {
    const f = deckFor(req.params.fileId, req.user, 'editor');
    const s = q('SELECT * FROM slide_qa WHERE file_id = ? AND ended_at IS NULL ORDER BY started_at DESC').get(f.id);
    res.json(s ? view(s, req.user) : null);
  });
  r.post('/decks/:fileId/start', (req, res) => {
    const f = deckFor(req.params.fileId, req.user, 'editor');
    let s = q('SELECT * FROM slide_qa WHERE file_id = ? AND ended_at IS NULL ORDER BY started_at DESC').get(f.id);
    if (!s) {
      const id = uid();
      q('INSERT INTO slide_qa (id, file_id, org_id, code, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, f.id, req.user.org_id, newCode(), req.user.id, now());
      s = q('SELECT * FROM slide_qa WHERE id = ?').get(id);
    }
    res.status(201).json(view(s, req.user));
  });
  r.post('/:code/end', (req, res) => {
    const s = sessionFor(req.params.code, req.user);
    if (!mayRun(s, req.user)) throw forbidden('Only the presenter ends the Q&A');
    if (!s.ended_at) q('UPDATE slide_qa SET ended_at = ? WHERE id = ?').run(now(), s.id);
    res.json(view(q('SELECT * FROM slide_qa WHERE id = ?').get(s.id), req.user));
  });

  // For everyone at the company with the code.
  r.get('/:code', (req, res) => res.json(view(sessionFor(req.params.code, req.user), req.user)));
  r.post('/:code/questions', (req, res) => {
    const s = sessionFor(req.params.code, req.user);
    if (s.ended_at) throw bad('This Q&A has ended');
    const body = str(req.body?.body, { required: true, max: 500, name: 'Question' });
    if (q('SELECT COUNT(*) AS n FROM slide_qa_questions WHERE session_id = ?').get(s.id).n >= MAX_QUESTIONS) throw bad('This Q&A has enough questions');
    if (q('SELECT COUNT(*) AS n FROM slide_qa_questions WHERE session_id = ? AND user_id = ?').get(s.id, req.user.id).n >= MAX_PER_PERSON) throw bad(`At most ${MAX_PER_PERSON} questions each`);
    q('INSERT INTO slide_qa_questions (id, session_id, user_id, body, anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uid(), s.id, req.user.id, body, req.body?.anonymous ? 1 : 0, now());
    res.status(201).json(view(s, req.user));
  });
  const questionFor = (req) => {
    const k = q('SELECT * FROM slide_qa_questions WHERE id = ?').get(String(req.params.id));
    const s = k && q('SELECT * FROM slide_qa WHERE id = ?').get(k.session_id);
    if (!s || s.org_id !== req.user.org_id) throw notFound('Question not found');
    return { k, s };
  };
  // Upvote (once each, not your own question); { on: false } takes it back.
  r.post('/questions/:id/vote', (req, res) => {
    const { k, s } = questionFor(req);
    if (s.ended_at) throw bad('This Q&A has ended');
    if (k.user_id === req.user.id) throw bad('You can’t upvote your own question');
    if (req.body?.on === false) q('DELETE FROM slide_qa_votes WHERE question_id = ? AND user_id = ?').run(k.id, req.user.id);
    else q('INSERT OR IGNORE INTO slide_qa_votes (question_id, user_id) VALUES (?, ?)').run(k.id, req.user.id);
    res.json(view(s, req.user));
  });
  // The presenter marks a question answered (or not).
  r.post('/questions/:id/answered', (req, res) => {
    const { k, s } = questionFor(req);
    if (!mayRun(s, req.user)) throw forbidden('Only the presenter marks questions answered');
    q('UPDATE slide_qa_questions SET answered_at = ? WHERE id = ?').run(req.body?.answered === false ? null : now(), k.id);
    res.json(view(s, req.user));
  });
  // Whoever asked it, or the presenter, takes a question away.
  r.delete('/questions/:id', (req, res) => {
    const { k, s } = questionFor(req);
    if (k.user_id !== req.user.id && !mayRun(s, req.user)) throw forbidden('Only whoever asked it, or the presenter');
    q('DELETE FROM slide_qa_questions WHERE id = ?').run(k.id);
    res.json(view(s, req.user));
  });
  return r;
}
