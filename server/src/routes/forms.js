// Forms: questionnaires, sign-up sheets and quick polls. The owner builds the questions, shares a link
// (/f/<token>) that people in the company (signed in) or anyone can fill in, and reads the answers:
// a summary per question, each response, a CSV download, or a copy in a new spreadsheet in Drive.
// Mounted at /api/forms (owner) and /api/public/forms (people filling it in).
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError } from '../util.js';
import { userFromToken, tokenFromReq } from '../auth.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { insertFile } from './files.js';

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

export const TYPES = ['short', 'paragraph', 'choice', 'checkbox', 'dropdown', 'scale', 'date'];
const WITH_OPTIONS = new Set(['choice', 'checkbox', 'dropdown']);
const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 50;
const MAX_RESPONSES = 10000;
const MAX_FORMS = 500;

/** Tidy questions from the editor: known types, trimmed text, options only where they belong. */
export function cleanQuestions(list) {
  if (!Array.isArray(list)) throw bad('questions must be a list');
  if (list.length > MAX_QUESTIONS) throw bad(`A form can have up to ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  return list.map((raw, i) => {
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
    if (type === 'scale') {
      out.max = [5, 10].includes(Number(raw?.max)) ? Number(raw.max) : 5;
      out.low = String(raw?.low ?? '').slice(0, 60);
      out.high = String(raw?.high ?? '').slice(0, 60);
    }
    return out;
  });
}

/** Check one person's answers against the questions; returns what's kept (only answered questions). */
export function checkAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw bad('answers must be an object');
  const out = {};
  for (const qu of questions) {
    let a = answers[qu.id];
    const name = qu.title || 'This question';
    if (qu.type === 'checkbox') {
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
    out[qu.id] = a;
  }
  return out;
}

/** One answer as text, for CSV and spreadsheets. */
const asText = (a) => (Array.isArray(a) ? a.join('; ') : a == null ? '' : String(a));
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // don't let a spreadsheet run an answer as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const parse = (f) => ({ ...f, questions: JSON.parse(f.questions || '[]'), accepting: !!f.accepting, one_per_person: !!f.one_per_person, notify: !!f.notify });
const responsesOf = (formId) => q(`SELECT r.id, r.answers, r.created_at, u.name AS user_name, u.username AS user_email
                                   FROM form_responses r LEFT JOIN users u ON u.id = r.user_id WHERE r.form_id = ? ORDER BY r.created_at`).all(formId)
  .map((r) => ({ id: r.id, created_at: r.created_at, user: r.user_email ? { name: r.user_name, email: r.user_email } : null, answers: JSON.parse(r.answers) }));

/** The table of responses: a header row, then one row per response. */
export function responseTable(form, responses, { withPeople = form.audience === 'org' || responses.some((r) => r.user) } = {}) {
  const head = ['Submitted', ...(withPeople ? ['Name', 'Email'] : []), ...form.questions.map((qu) => qu.title || 'Untitled question')];
  const rows = responses.map((r) => [new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19),
    ...(withPeople ? [r.user?.name || '', r.user?.email || ''] : []), ...form.questions.map((qu) => asText(r.answers[qu.id]))]);
  return [head, ...rows];
}

const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function ownForm(id, user) {
  const f = q('SELECT * FROM forms WHERE id = ?').get(String(id));
  if (!f || f.owner_id !== user.id) throw notFound('Form not found');
  return parse(f);
}

const summaryRow = (f) => ({ id: f.id, title: f.title, token: f.token, audience: f.audience, accepting: !!f.accepting, created_at: f.created_at, updated_at: f.updated_at,
  responses: q('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(f.id).n,
  last_response: q('SELECT MAX(created_at) AS t FROM form_responses WHERE form_id = ?').get(f.id).t });

export default function formRoutes() {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(q('SELECT * FROM forms WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user.id).map(summaryRow));
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

  r.get('/:id', (req, res) => res.json({ ...ownForm(req.params.id, req.user), responses: summaryRow(q('SELECT * FROM forms WHERE id = ?').get(req.params.id)).responses }));

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
    };
    if (next.audience === 'public' && f.audience !== 'public' && !req.user.allow_links) throw forbidden('Your company has turned off links for people outside it');
    q(`UPDATE forms SET title = ?, description = ?, questions = ?, audience = ?, accepting = ?, one_per_person = ?, confirmation = ?, notify = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.description, JSON.stringify(next.questions), next.audience, next.accepting ? 1 : 0, next.one_per_person ? 1 : 0, next.confirmation, next.notify ? 1 : 0, now(), f.id);
    res.json(ownForm(f.id, req.user));
  });

  r.post('/:id/copy', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const id = uid();
    const t = now();
    q(`INSERT INTO forms (id, org_id, owner_id, token, title, description, questions, audience, accepting, one_per_person, confirmation, notify, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(id, req.user.org_id, req.user.id, crypto.randomBytes(12).toString('base64url'), `Copy of ${f.title}`.slice(0, 200), f.description, JSON.stringify(f.questions),
        f.audience === 'public' && !req.user.allow_links ? 'org' : f.audience, f.one_per_person ? 1 : 0, f.confirmation, f.notify ? 1 : 0, t, t);
    res.status(201).json(ownForm(id, req.user));
  });

  // A new link: the old one stops working (for when it went somewhere it shouldn't).
  r.post('/:id/new-link', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    q('UPDATE forms SET token = ?, updated_at = ? WHERE id = ?').run(crypto.randomBytes(12).toString('base64url'), now(), f.id);
    res.json(ownForm(f.id, req.user));
  });

  r.delete('/:id', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    q('DELETE FROM forms WHERE id = ?').run(f.id);
    res.json({ ok: true });
  });

  r.get('/:id/responses', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    res.json({ questions: f.questions, audience: f.audience, responses: responsesOf(f.id) });
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
    res.json({ ok: true });
  });
  r.delete('/:id/responses', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    res.json({ deleted: q('DELETE FROM form_responses WHERE form_id = ?').run(f.id).changes });
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
    res.json({ title: form.title, description: form.description, questions: form.questions, accepting: form.accepting, audience: form.audience,
      one_per_person: form.audience === 'org' && form.one_per_person, answered, org_name: f.org_name,
      you: form.audience === 'org' ? { name: user.name, email: user.email } : null, is_owner: user?.id === form.owner_id });
  });

  r.post('/:token', (req, res) => {
    const { form, user } = openForm(req);
    if (!form.accepting) throw new HttpError(409, 'This form is no longer accepting responses');
    const answers = checkAnswers(form.questions, req.body?.answers);
    if (form.audience === 'public') limit(req.ip);
    const id = uid();
    tx(() => {
      if (q('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(form.id).n >= MAX_RESPONSES) throw new HttpError(409, 'This form is full');
      if (form.audience === 'org' && form.one_per_person && q('SELECT 1 FROM form_responses WHERE form_id = ? AND user_id = ?').get(form.id, user.id)) {
        throw new HttpError(409, 'You have already filled in this form');
      }
      q('INSERT INTO form_responses (id, form_id, user_id, answers, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, form.id, form.audience === 'org' ? user.id : null, JSON.stringify(answers), now());
    });
    sendTo([form.owner_id], { type: 'form-response', form_id: form.id });
    if (form.notify && user?.id !== form.owner_id) {
      bell([form.owner_id], { kind: 'form', title: `New response to “${form.title}”`, body: form.audience === 'org' ? `From ${user.name}` : null, link: `/forms/${form.id}?tab=responses`, actor: user?.id || null });
    }
    res.status(201).json({ ok: true, confirmation: form.confirmation || '' });
  });
  return r;
}
