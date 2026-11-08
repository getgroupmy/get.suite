import { shownQuestions } from '../formpath.js';
// Forms: questionnaires, sign-up sheets and quick polls. The owner builds the questions, shares a link
// (/f/<token>) that people in the company (signed in) or anyone can fill in, and reads the answers:
// a summary per question, each response, a CSV download, or a copy in a new spreadsheet in Drive.
// Mounted at /api/forms (owner) and /api/public/forms (people filling it in).
import { CHECKS, cleanCheck, checkProblem } from '../formcheck.js';
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError, isInlineSafe } from '../util.js';
import { userFromToken, tokenFromReq } from '../auth.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { insertFile, receiveUpload, cleanName } from './files.js';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../db.js';
import { mimeFor } from '../util.js';

q(`CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT 'org',     -- org: people in the company, signed in | public: anyone with the link
  accepting INTEGER NOT NULL DEFAULT 1,
  one_per_person INTEGER NOT NULL DEFAULT 0, -- company forms only: one response each
  confirmation TEXT NOT NULL DEFAULT '',
  notify INTEGER NOT NULL DEFAULT 1,         -- a bell notification for each response
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  answers TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS form_responses_form ON form_responses(form_id, created_at)').run();
// Colleagues who can edit a form and read its responses with the owner.
q(`CREATE TABLE IF NOT EXISTS form_editors (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, user_id)
)`).run();
for (const [col, type] of [['close_at', 'INTEGER'], ['max_responses', 'INTEGER'], ['quiz', 'INTEGER NOT NULL DEFAULT 0'], ['show_score', 'INTEGER NOT NULL DEFAULT 1']]) {
  if (!q('PRAGMA table_info(forms)').all().some((c) => c.name === col)) q(`ALTER TABLE forms ADD COLUMN ${col} ${type}`).run();
}
const MAX_EDITORS = 50;

export const TYPES = ['short', 'paragraph', 'choice', 'checkbox', 'dropdown', 'scale', 'date', 'file', 'section'];
const WITH_OPTIONS = new Set(['choice', 'checkbox', 'dropdown']);
const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 50;
const MAX_RESPONSES = 10000;
// File upload questions: each file up to 10 MB, a few per question. Uploads wait here (for a day at
// most) until the response is sent, then go into a folder in the form owner's Drive.
export const MAX_FILES = 5, MAX_FILE_BYTES = 10 * 1024 * 1024;
q(`CREATE TABLE IF NOT EXISTS form_uploads (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  storage TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
if (!q('PRAGMA table_info(forms)').all().some((c) => c.name === 'files_folder')) q('ALTER TABLE forms ADD COLUMN files_folder TEXT').run();
/** Throw away uploads that never became part of a response. */
function dropStaleUploads(t = Date.now()) {
  for (const u of q('SELECT id, storage FROM form_uploads WHERE created_at < ?').all(t - 864e5)) {
    fs.rm(path.join(FILES_DIR, u.storage), { force: true }, () => {});
    q('DELETE FROM form_uploads WHERE id = ?').run(u.id);
  }
}
/** The form's folder for uploaded files in its owner's Drive (made the first time, or again if it's gone). */
function filesFolder(form) {
  const cur = form.files_folder && q("SELECT id FROM files WHERE id = ? AND kind = 'folder' AND trashed = 0 AND owner_id = ?").get(form.files_folder, form.owner_id);
  if (cur) return cur.id;
  const id = insertFile({ owner: form.owner_id, parentId: null, name: `${(form.title || 'Form').slice(0, 200)} (File uploads)`, kind: 'folder' });
  q('UPDATE forms SET files_folder = ? WHERE id = ?').run(id, form.id);
  return id;
}
const MAX_FORMS = 500;

/** Tidy questions from the editor: known types, trimmed text, options only where they belong. */
export function cleanQuestions(list) {
  if (!Array.isArray(list)) throw bad('questions must be a list');
  if (list.length > MAX_QUESTIONS) throw bad(`A form can have up to ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  const cleaned = list.map((raw, i) => {
    const type = TYPES.includes(raw?.type) ? raw.type : 'short';
    let id = typeof raw?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString('base64url');
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const out = { id, type, title: String(raw?.title ?? '').slice(0, 300), required: !!raw?.required };
    const help = String(raw?.help ?? '').slice(0, 1000);
    if (help) out.help = help;
    if (WITH_OPTIONS.has(type)) {
      const opts = (Array.isArray(raw?.options) ? raw.options : []).map((o) => String(o ?? '').trim().slice(0, 200)).filter(Boolean);
      out.options = [...new Set(opts)].slice(0, MAX_OPTIONS);
      if (!out.options.length) out.options = ['Option 1'];
    }
    if (type === 'section') { delete out.required; return out; } // a new page: its title and help only
    // Response validation; a rule that isn't finished yet (no number typed) is kept out until it is.
    if (CHECKS[type]) { try { const c = cleanCheck(type, raw?.check); if (c) out.check = c; } catch {} }
    if (type === 'file') out.max_files = Math.min(MAX_FILES, Math.max(1, Math.round(Number(raw?.max_files)) || 1)); // up to this many files
    if (type === 'scale') {
      out.max = [5, 10].includes(Number(raw?.max)) ? Number(raw.max) : 5;
      out.low = String(raw?.low ?? '').slice(0, 60);
      out.high = String(raw?.high ?? '').slice(0, 60);
    }
    // Quizzes: the right answer (an option, several for tick boxes, or the text of a short answer) and its points.
    if (GRADED.has(type) && raw?.answer !== undefined && raw?.answer !== null && raw?.answer !== '') {
      if (type === 'checkbox') {
        const a = (Array.isArray(raw.answer) ? raw.answer : [raw.answer]).map(String).filter((x) => out.options.includes(x));
        if (a.length) out.answer = out.options.filter((o) => a.includes(o));
      } else if (type === 'short') out.answer = String(raw.answer).trim().slice(0, 500);
      else if (out.options.includes(String(raw.answer))) out.answer = String(raw.answer);
      if (out.answer !== undefined) out.points = Math.min(100, Math.max(0, Math.round(Number(raw.points ?? 1)) || 0));
    }
    return out;
  });
  // "Go to section": choice and dropdown answers that lead to a later section (or to the end).
  const sectionIds = cleaned.filter((x) => x.type === 'section').map((x) => x.id);
  cleaned.forEach((qu, i) => {
    const raw = list[i]?.goto;
    if (!raw || typeof raw !== 'object' || !['choice', 'dropdown'].includes(qu.type)) return;
    const later = new Set(cleaned.slice(i + 1).filter((x) => x.type === 'section').map((x) => x.id));
    const g = {};
    for (const o of qu.options) { const to = raw[o]; if (to === 'submit' || (sectionIds.includes(to) && later.has(to))) g[o] = to; }
    if (Object.keys(g).length) qu.goto = g;
  });
  // "After this section": a later section or the end.
  cleaned.forEach((qu, i) => {
    if (qu.type !== 'section') return;
    const to = list[i]?.after;
    const later = cleaned.slice(i + 1).filter((x) => x.type === 'section').map((x) => x.id);
    if (to === 'submit' || later.includes(to)) qu.after = to;
  });
  return cleaned;
}

const GRADED = new Set(['short', 'choice', 'checkbox', 'dropdown']);
/** A quiz's score: { score, max, right: { questionId: true | false } } over the questions with an answer key. */
export function scoreOf(questions, answers) {
  let score = 0, max = 0;
  const right = {};
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const qu of questions) {
    if (qu.answer === undefined) continue;
    max += qu.points ?? 1;
    const a = answers?.[qu.id];
    const ok = qu.type === 'checkbox'
      ? Array.isArray(a) && a.length === qu.answer.length && qu.answer.every((x) => a.includes(x))
      : qu.type === 'short' ? norm(a) !== '' && norm(a) === norm(qu.answer) : a === qu.answer;
    right[qu.id] = ok;
    if (ok) score += qu.points ?? 1;
  }
  return { score, max, right };
}
/** The questions as people filling the form in see them: no answer key. */
const withoutKey = (questions) => questions.map(({ answer, points, ...qu }) => qu);

/** Check one person's answers against the questions; returns what's kept (only answered questions). */
export function checkAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw bad('answers must be an object');
  const out = {};
  // Only the pages they went through count (a skipped page's required questions aren't required).
  for (const qu of shownQuestions(questions, answers)) {
    let a = answers[qu.id];
    const name = qu.title || 'This question';
    if (qu.type === 'file') {
      // The uploads (their ids from /upload); they become Drive files when the response is saved.
      a = (Array.isArray(a) ? a : a == null || a === '' ? [] : [a]).map(String).filter(Boolean);
      if (a.length > (qu.max_files || 1)) throw bad(`${name}: up to ${qu.max_files || 1} file${(qu.max_files || 1) === 1 ? '' : 's'}`);
      if (!a.length) a = undefined;
    } else if (qu.type === 'checkbox') {
      a = (Array.isArray(a) ? a : a == null || a === '' ? [] : [a]).map(String);
      if (a.some((x) => !qu.options.includes(x))) throw bad(`${name}: choose from the options`);
      a = qu.options.filter((o) => a.includes(o)); // the form's order, no repeats
      if (!a.length) a = undefined;
    } else if (qu.type === 'scale') {
      if (a === '' || a == null) a = undefined;
      else {
        a = Number(a);
        if (!Number.isInteger(a) || a < 1 || a > qu.max) throw bad(`${name}: pick a number from 1 to ${qu.max}`);
      }
    } else {
      a = a == null ? '' : String(a).trim();
      if (WITH_OPTIONS.has(qu.type) && a && !qu.options.includes(a)) throw bad(`${name}: choose from the options`);
      if (qu.type === 'date' && a && !/^\d{4}-\d{2}-\d{2}$/.test(a)) throw bad(`${name}: enter a date`);
      if (a.length > (qu.type === 'paragraph' ? 5000 : 500)) throw bad(`${name}: that answer is too long`);
      if (!a) a = undefined;
    }
    if (a === undefined) { if (qu.required) throw bad(`${name}: this question needs an answer`); continue; }
    const problem = checkProblem(qu.check, a);
    if (problem) throw bad(`${name}: ${problem}`);
    out[qu.id] = a;
  }
  return out;
}

/** One answer as text, for CSV and spreadsheets. */
const asText = (a) => (Array.isArray(a) ? a.map((x) => (x && typeof x === 'object' ? x.name : x)).join('; ') : a == null ? '' : String(a));
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // don't let a spreadsheet run an answer as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const parse = (f) => ({ ...f, questions: JSON.parse(f.questions || '[]'), accepting: !!f.accepting, one_per_person: !!f.one_per_person, notify: !!f.notify, quiz: !!f.quiz, show_score: !!f.show_score });
const responsesOf = (formId) => q(`SELECT r.id, r.answers, r.created_at, u.name AS user_name, u.username AS user_email
                                   FROM form_responses r LEFT JOIN users u ON u.id = r.user_id WHERE r.form_id = ? ORDER BY r.created_at`).all(formId)
  .map((r) => ({ id: r.id, created_at: r.created_at, user: r.user_email ? { name: r.user_name, email: r.user_email } : null, answers: JSON.parse(r.answers) }));

/** The table of responses: a header row, then one row per response. */
export function responseTable(form, responses, { withPeople = form.audience === 'org' || responses.some((r) => r.user) } = {}) {
  const quiz = !!form.quiz;
  const head = ['Submitted', ...(withPeople ? ['Name', 'Email'] : []), ...(quiz ? ['Score'] : []), ...form.questions.filter((qu) => qu.type !== 'section').map((qu) => qu.title || 'Untitled question')];
  const rows = responses.map((r) => {
    const sc = quiz ? scoreOf(form.questions, r.answers) : null;
    return [new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19),
      ...(withPeople ? [r.user?.name || '', r.user?.email || ''] : []), ...(quiz ? [`${sc.score} / ${sc.max}`] : []), ...form.questions.filter((qu) => qu.type !== 'section').map((qu) => asText(r.answers[qu.id]))];
  });
  return [head, ...rows];
}

const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

const countOf = (formId) => q('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(formId).n;
const editorsOf = (formId) => q(`SELECT u.id, u.name, u.username AS email FROM form_editors e JOIN users u ON u.id = e.user_id
                                 WHERE e.form_id = ? ORDER BY e.added_at`).all(formId);
/** Everyone who works on the form: its owner and its editors. */
export const teamOf = (f) => [f.owner_id, ...editorsOf(f.id).map((u) => u.id)];

/** Why a form isn't taking answers right now, or null when it is. */
export function closedReason(f, t = Date.now(), count = null) {
  if (!f.accepting) return 'closed';
  if (f.close_at && f.close_at <= t) return 'ended';
  if (f.max_responses && (count ?? countOf(f.id)) >= f.max_responses) return 'full';
  return null;
}
const CLOSED_TEXT = { closed: 'This form is no longer accepting responses', ended: 'This form closed', full: 'This form has all the responses it needs' };

/** A form you own or edit (ownerOnly: you must own it). */
function ownForm(id, user, { ownerOnly = false } = {}) {
  const f = q('SELECT f.*, u.name AS owner_name, u.username AS owner_email FROM forms f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(String(id));
  const mine = f && f.owner_id === user.id;
  if (!f || (!mine && !q('SELECT 1 FROM form_editors WHERE form_id = ? AND user_id = ?').get(f.id, user.id))) throw notFound('Form not found');
  if (ownerOnly && !mine) throw forbidden('Only the owner can do that');
  return { ...parse(f), role: mine ? 'owner' : 'editor', editors: editorsOf(f.id), owner: { id: f.owner_id, name: f.owner_name, email: f.owner_email } };
}
const changed = (f, by) => sendTo(teamOf(f).filter((x) => x !== by), { type: 'form-changed', form_id: f.id });

const summaryRow = (f, me) => {
  const responses = countOf(f.id);
  return { id: f.id, title: f.title, token: f.token, audience: f.audience, accepting: !!f.accepting, closed: closedReason(f, Date.now(), responses),
    created_at: f.created_at, updated_at: f.updated_at, responses, last_response: q('SELECT MAX(created_at) AS t FROM form_responses WHERE form_id = ?').get(f.id).t,
    owner_name: f.owner_id === me ? null : f.owner_name };
};

export default function formRoutes() {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(q(`SELECT f.*, u.name AS owner_name FROM forms f JOIN users u ON u.id = f.owner_id
                WHERE f.owner_id = ? OR f.id IN (SELECT form_id FROM form_editors WHERE user_id = ?) ORDER BY f.updated_at DESC`)
      .all(req.user.id, req.user.id).map((f) => summaryRow(f, req.user.id)));
  });

  r.post('/', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM forms WHERE owner_id = ?').get(req.user.id).n >= MAX_FORMS) throw bad(`You can have up to ${MAX_FORMS} forms`);
    const title = str(req.body?.title ?? '', { max: 200 }) || 'Untitled form';
    const id = uid();
    const t = now();
    const questions = cleanQuestions(req.body?.questions ?? [{ type: 'choice', title: '', options: ['Option 1'] }]);
    q(`INSERT INTO forms (id, org_id, owner_id, token, title, questions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.org_id, req.user.id, crypto.randomBytes(12).toString('base64url'), title, JSON.stringify(questions), t, t);
    res.status(201).json(ownForm(id, req.user));
  });

  r.get('/:id', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const responses = countOf(f.id);
    res.json({ ...f, responses, closed: closedReason(f, Date.now(), responses) });
  });

  r.put('/:id', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const b = req.body || {};
    const next = {
      title: 'title' in b ? (str(b.title, { max: 200 }) || 'Untitled form') : f.title,
      description: 'description' in b ? str(b.description ?? '', { max: 5000 }) : f.description,
      questions: 'questions' in b ? cleanQuestions(b.questions) : f.questions,
      audience: 'audience' in b ? (b.audience === 'public' ? 'public' : 'org') : f.audience,
      accepting: 'accepting' in b ? !!b.accepting : f.accepting,
      one_per_person: 'one_per_person' in b ? !!b.one_per_person : f.one_per_person,
      confirmation: 'confirmation' in b ? str(b.confirmation ?? '', { max: 1000 }) : f.confirmation,
      notify: 'notify' in b ? !!b.notify : f.notify,
      quiz: 'quiz' in b ? !!b.quiz : f.quiz,
      show_score: 'show_score' in b ? !!b.show_score : f.show_score,
      close_at: 'close_at' in b ? (b.close_at == null || b.close_at === '' ? null : Number(b.close_at)) : f.close_at,
      max_responses: 'max_responses' in b ? (b.max_responses == null || b.max_responses === '' ? null : Number(b.max_responses)) : f.max_responses,
    };
    if (next.close_at !== null && (!Number.isFinite(next.close_at) || next.close_at < 0)) throw bad('close_at must be a time');
    if (next.max_responses !== null && (!Number.isInteger(next.max_responses) || next.max_responses < 1 || next.max_responses > MAX_RESPONSES)) {
      throw bad(`The response limit must be from 1 to ${MAX_RESPONSES}`);
    }
    if (next.audience === 'public' && f.audience !== 'public' && !req.user.allow_links) throw forbidden('Your company has turned off links for people outside it');
    q(`UPDATE forms SET title = ?, description = ?, questions = ?, audience = ?, accepting = ?, one_per_person = ?, confirmation = ?, notify = ?,
       close_at = ?, max_responses = ?, quiz = ?, show_score = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.description, JSON.stringify(next.questions), next.audience, next.accepting ? 1 : 0, next.one_per_person ? 1 : 0, next.confirmation, next.notify ? 1 : 0,
        next.close_at, next.max_responses, next.quiz ? 1 : 0, next.show_score ? 1 : 0, now(), f.id);
    changed(f, req.user.id);
    const out = ownForm(f.id, req.user);
    res.json({ ...out, responses: countOf(f.id), closed: closedReason(out) });
  });

  r.post('/:id/copy', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const id = uid();
    const t = now();
    q(`INSERT INTO forms (id, org_id, owner_id, token, title, description, questions, audience, accepting, one_per_person, confirmation, notify, quiz, show_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.org_id, req.user.id, crypto.randomBytes(12).toString('base64url'), `Copy of ${f.title}`.slice(0, 200), f.description, JSON.stringify(f.questions),
        f.audience === 'public' && !req.user.allow_links ? 'org' : f.audience, f.one_per_person ? 1 : 0, f.confirmation, f.notify ? 1 : 0, f.quiz ? 1 : 0, f.show_score ? 1 : 0, t, t);
    res.status(201).json(ownForm(id, req.user));
  });

  // A new link: the old one stops working (for when it went somewhere it shouldn't).
  r.post('/:id/new-link', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    q('UPDATE forms SET token = ?, updated_at = ? WHERE id = ?').run(crypto.randomBytes(12).toString('base64url'), now(), f.id);
    changed(f, req.user.id);
    res.json(ownForm(f.id, req.user));
  });

  r.delete('/:id', (req, res) => {
    const f = ownForm(req.params.id, req.user, { ownerOnly: true });
    const team = teamOf(f);
    q('DELETE FROM forms WHERE id = ?').run(f.id);
    sendTo(team.filter((x) => x !== req.user.id), { type: 'form-changed', form_id: f.id, deleted: true });
    res.json({ ok: true });
  });

  // Editors: colleagues (same company) who can change the form and read its answers. The owner adds and
  // removes them; an editor can take themselves off.
  r.post('/:id/editors', (req, res) => {
    const f = ownForm(req.params.id, req.user, { ownerOnly: true });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const u = q('SELECT id, name, disabled FROM users WHERE lower(username) = ? AND org_id = ?').get(email, req.user.org_id);
    if (!u || u.disabled) throw bad('No one at your company has that address');
    if (u.id === f.owner_id) throw bad('That is the owner');
    if (f.editors.length >= MAX_EDITORS) throw bad(`A form can have up to ${MAX_EDITORS} editors`);
    if (q('INSERT OR IGNORE INTO form_editors (form_id, user_id, added_at) VALUES (?, ?, ?)').run(f.id, u.id, now()).changes) {
      bell([u.id], { kind: 'share', title: `${req.user.name} added you to the form “${f.title}”`, link: `/forms/${f.id}`, actor: req.user.id });
      changed(f, req.user.id);
    }
    res.json(editorsOf(f.id));
  });
  r.delete('/:id/editors/:userId', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    if (f.role !== 'owner' && req.params.userId !== req.user.id) throw forbidden('Only the owner can do that');
    q('DELETE FROM form_editors WHERE form_id = ? AND user_id = ?').run(f.id, req.params.userId);
    sendTo([req.params.userId], { type: 'form-changed', form_id: f.id, removed: true });
    changed(f, req.user.id);
    res.json(editorsOf(f.id));
  });

  r.get('/:id/responses', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const list = responsesOf(f.id);
    res.json({ questions: f.questions, audience: f.audience, quiz: f.quiz, responses: f.quiz ? list.map((x) => ({ ...x, ...scoreOf(f.questions, x.answers) })) : list });
  });

  // A file sent with a response (for the owner and editors).
  r.get('/:id/file/:fileId', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const fileId = String(req.params.fileId);
    if (!q('SELECT 1 FROM form_responses WHERE form_id = ? AND answers LIKE ?').get(f.id, `%"file_id":"${fileId.replace(/[%_"\\]/g, '')}"%`)) throw notFound('File not found');
    const file = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
    if (!file) throw notFound('That file has been deleted');
    const inline = req.query.download === undefined && isInlineSafe(file.mime);
    res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
    if (file.mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(path.join(FILES_DIR, file.storage));
  });

  r.get('/:id/responses.csv', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const csv = responseTable(f, responsesOf(f.id)).map((row) => row.map(csvCell).join(',')).join('\r\n');
    const name = `${f.title.replace(/[^\w .-]+/g, '').trim() || 'form'} responses.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(`﻿${csv}\r\n`);
  });

  // A copy of the responses so far in a new spreadsheet in your Drive.
  r.post('/:id/sheet', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const table = responseTable(f, responsesOf(f.id));
    const cells = {};
    table.forEach((row, ri) => row.forEach((v, ci) => { if (v !== '') cells[`${colName(ci)}${ri + 1}`] = /^[=]/.test(v) ? `'${v}` : v; }));
    const colWidths = {};
    table[0].forEach((h, ci) => { colWidths[colName(ci)] = ci === 0 ? 160 : Math.min(320, Math.max(100, h.length * 8)); });
    const fileId = insertFile({ owner: req.user.id, parentId: null, name: `${f.title} (responses)`.slice(0, 200), kind: 'sheet',
      content: JSON.stringify({ sheets: [{ name: 'Responses', cells, colWidths, frozen: { rows: 1 } }] }) });
    res.status(201).json({ id: fileId });
  });

  r.delete('/:id/responses/:rid', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    if (!q('DELETE FROM form_responses WHERE id = ? AND form_id = ?').run(req.params.rid, f.id).changes) throw notFound('Response not found');
    sendTo(teamOf(f), { type: 'form-response', form_id: f.id });
    res.json({ ok: true });
  });
  r.delete('/:id/responses', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const deleted = q('DELETE FROM form_responses WHERE form_id = ?').run(f.id).changes;
    sendTo(teamOf(f), { type: 'form-response', form_id: f.id });
    res.json({ deleted });
  });

  return r;
}

const recent = new Map(); // ip -> times of anonymous responses in the last hour
function limit(ip) {
  const t = Date.now();
  const list = (recent.get(ip) || []).filter((x) => t - x < 36e5);
  if (list.length >= 30) throw new HttpError(429, 'Too many responses from here. Try again later.');
  list.push(t);
  recent.set(ip, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((x) => t - x < 36e5)) recent.delete(k);
}

/** The form behind a link, and whether this visitor may fill it in. */
function openForm(req) {
  const f = q(`SELECT f.*, u.disabled AS owner_disabled, u.name AS owner_name, o.name AS org_name, o.allow_links
               FROM forms f JOIN users u ON u.id = f.owner_id JOIN orgs o ON o.id = f.org_id WHERE f.token = ?`).get(String(req.params.token));
  if (!f || f.owner_disabled) throw notFound('This form does not exist or has been deleted');
  const form = parse(f);
  const signedIn = userFromToken(tokenFromReq(req));
  const user = signedIn?.needs_two_factor ? null : signedIn;
  if (form.audience === 'public' && !f.allow_links) throw new HttpError(403, 'This form is closed');
  if (form.audience === 'org') {
    if (!user) throw new HttpError(401, `Sign in with your ${f.org_name} account to fill in this form`);
    if (user.org_id !== form.org_id) throw forbidden(`Only people at ${f.org_name} can fill in this form`);
  }
  return { form, user, f };
}

export function publicFormRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });

  r.get('/:token', (req, res) => {
    const { form, user, f } = openForm(req);
    const answered = !!user && form.audience === 'org' && form.one_per_person
      && !!q('SELECT 1 FROM form_responses WHERE form_id = ? AND user_id = ?').get(form.id, user.id);
    const closed = closedReason(form);
    res.json({ title: form.title, description: form.description, questions: withoutKey(form.questions), quiz: form.quiz, accepting: !closed, closed, closed_text: closed ? CLOSED_TEXT[closed] : null, audience: form.audience,
      one_per_person: form.audience === 'org' && form.one_per_person, answered, org_name: f.org_name,
      you: form.audience === 'org' ? { name: user.name, email: user.email } : null, is_owner: !!user && teamOf(form).includes(user.id) });
  });

  // A file for a file upload question (?name=): kept until the response is sent. Returns { id, name, size }.
  r.post('/:token/upload', async (req, res) => {
    const { form } = openForm(req);
    const shut = closedReason(form);
    if (shut) throw new HttpError(409, CLOSED_TEXT[shut]);
    if (!form.questions.some((qu) => qu.type === 'file')) throw bad('This form has no file questions');
    if (form.audience === 'public') limit(req.ip);
    dropStaleUploads();
    const name = cleanName(String(req.query.name || 'file'));
    const { storage, size } = await receiveUpload(req, form.org_id, MAX_FILE_BYTES).catch((e) => { throw e.status === 413 ? new HttpError(413, 'Files can be up to 10 MB') : e; });
    const id = crypto.randomBytes(16).toString('base64url');
    q('INSERT INTO form_uploads (id, form_id, storage, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, form.id, storage, name, size, now());
    res.status(201).json({ id, name, size });
  });

  r.post('/:token', (req, res) => {
    const { form, user } = openForm(req);
    const shut = closedReason(form);
    if (shut) throw new HttpError(409, CLOSED_TEXT[shut]);
    const answers = checkAnswers(form.questions, req.body?.answers);
    // File answers: uploads to this form that haven't been used.
    const fileQs = form.questions.filter((qu) => qu.type === 'file' && answers[qu.id]);
    for (const qu of fileQs) for (const up of answers[qu.id]) {
      if (!q('SELECT 1 FROM form_uploads WHERE id = ? AND form_id = ?').get(up, form.id)) throw bad(`${qu.title || 'A file question'}: upload the file again`);
    }
    if (form.audience === 'public') limit(req.ip);
    const id = uid();
    const who = form.audience === 'org' ? user.name : null;
    if (fileQs.length) {
      const folder = filesFolder(form);
      for (const qu of fileQs) {
        answers[qu.id] = answers[qu.id].map((up) => {
          const u = q('SELECT * FROM form_uploads WHERE id = ?').get(up);
          const fileId = insertFile({ owner: form.owner_id, parentId: folder, name: who ? `${who} - ${u.name}` : u.name, kind: 'file', mime: mimeFor(u.name), size: u.size, storage: u.storage });
          q('UPDATE files SET description = ? WHERE id = ?').run(`Sent${who ? ` by ${who}` : ''} with “${form.title}”`, fileId);
          q('DELETE FROM form_uploads WHERE id = ?').run(up);
          return { file_id: fileId, name: u.name, size: u.size };
        });
      }
      sendTo([form.owner_id], { type: 'files-changed', parent_id: folder });
    }
    tx(() => {
      const n = countOf(form.id);
      if (n >= MAX_RESPONSES || (form.max_responses && n >= form.max_responses)) throw new HttpError(409, n >= MAX_RESPONSES ? 'This form is full' : CLOSED_TEXT.full);
      if (form.audience === 'org' && form.one_per_person && q('SELECT 1 FROM form_responses WHERE form_id = ? AND user_id = ?').get(form.id, user.id)) {
        throw new HttpError(409, 'You have already filled in this form');
      }
      q('INSERT INTO form_responses (id, form_id, user_id, answers, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, form.id, form.audience === 'org' ? user.id : null, JSON.stringify(answers), now());
    });
    const team = teamOf(form);
    sendTo(team, { type: 'form-response', form_id: form.id });
    if (form.notify) {
      bell(team.filter((x) => x !== user?.id), { kind: 'form', title: `New response to “${form.title}”`, body: form.audience === 'org' ? `From ${user.name}` : null, link: `/forms/${form.id}?tab=responses`, actor: user?.id || null });
    }
    const result = form.quiz && form.show_score ? scoreOf(form.questions, answers) : null;
    res.status(201).json({ ok: true, confirmation: form.confirmation || '', ...(result && { score: result.score, max: result.max, right: result.right }) });
  });
  return r;
}
