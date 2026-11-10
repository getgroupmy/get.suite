import { shownQuestions } from '../formpath.js';
// Forms: questionnaires, sign-up sheets and quick polls. The owner builds the questions, shares a link
// (/f/<token>) that people in the company (signed in) or anyone can fill in, and reads the answers:
// a summary per question, each response, a CSV download, or a copy in a new spreadsheet in Drive.
// Mounted at /api/forms (owner) and /api/public/forms (people filling it in).
import { mailEnabled } from '../mail/config.js';
import { smtpFor } from '../mail/imap.js';
import { CHECKS, cleanCheck, checkProblem } from '../formcheck.js';
import { templateList, templateById } from '../formtemplates.js';
import { excelFromTable, sendXlsx } from '../office/excel.js';
import { Router } from 'express';
import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden, HttpError, isInlineSafe } from '../util.js';
import { userFromToken, tokenFromReq } from '../auth.js';
import { notify as bell } from '../notifications.js';
import { sendTo } from '../hub.js';
import { insertFile, receiveUpload, cleanName } from './files.js';
import { changeSheet } from '../collab.js';
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
for (const [col, type] of [['edit_key', 'TEXT'], ['updated_at', 'INTEGER'], ['email', 'TEXT']]) {
  if (!q('PRAGMA table_info(form_responses)').all().some((c) => c.name === col)) q(`ALTER TABLE form_responses ADD COLUMN ${col} ${type}`).run();
}
// People the form was sent to by email (Send → Email), to see who hasn't answered and remind them.
q(`CREATE TABLE IF NOT EXISTS form_invites (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  reminded_at INTEGER,
  PRIMARY KEY (form_id, email)
)`).run();

/**
 * Who of those it was sent to has answered: on a company form, by their account; on a form for anyone
 * with the link, by the email address they gave (Collect email addresses). [{ email, sent_at, reminded_at, answered }].
 */
export function inviteStatus(form, invites, responses) {
  const answered = new Set();
  for (const r of responses) {
    if (r.user_email) answered.add(String(r.user_email).toLowerCase());
    if (r.email) answered.add(String(r.email).toLowerCase());
  }
  return invites.map((i) => ({ email: i.email, sent_at: i.sent_at, reminded_at: i.reminded_at || null, answered: answered.has(i.email) }))
    .sort((a, b) => a.answered - b.answered || a.email.localeCompare(b.email));
}
// auto_remind: a reminder goes by itself a day before the form closes; invite_base: the address the
// form's link was sent with (so the automatic reminder can link to it too).
for (const [col, type] of [['auto_remind', 'INTEGER NOT NULL DEFAULT 0'], ['auto_reminded_at', 'INTEGER'], ['invite_base', 'TEXT']]) {
  if (!q('PRAGMA table_info(forms)').all().some((c) => c.name === col)) q(`ALTER TABLE forms ADD COLUMN ${col} ${type}`).run();
}

/**
 * The people an address list reaches: a company group's or alias's address (one of the sender's
 * company) becomes the people in it, so each of them is sent the form and counted on their own.
 */
export function expandAddresses(emails, orgId) {
  const out = new Set();
  for (const e of emails) {
    const alias = q('SELECT targets FROM aliases WHERE address = ? AND org_id = ?').get(e, orgId);
    if (alias) for (const t of String(alias.targets || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) out.add(t);
    else out.add(e);
  }
  return [...out];
}

/** Send a form (or a reminder about it) from `user` to each address. Gives the addresses it couldn't send to. */
async function sendFormMail(user, base, form, emails, { message, reminder } = {}) {
  if (!mailEnabled()) throw bad('This server has no email');
  const link = `${base}/f/${form.token}`;
  const subject = reminder ? `Reminder: ${form.title}` : form.title;
  const lines = [message || (reminder ? `${user.name} is still waiting for your answers to "${form.title}".` : `${user.name} has invited you to fill in "${form.title}".`), '', `Fill it in: ${link}`];
  if (form.close_at) lines.push('', `It closes ${new Date(form.close_at).toUTCString().replace(/:\d\d GMT$/, ' UTC')}.`);
  const failed = [];
  for (const to of emails) {
    try { await smtpFor(user).sendMail({ from: { name: user.name, address: user.username }, to, subject, text: lines.join('\n') }); }
    catch { failed.push(to); }
  }
  return failed;
}

const invitesOf = (form) => inviteStatus(form, q('SELECT email, sent_at, reminded_at FROM form_invites WHERE form_id = ?').all(form.id),
  q('SELECT r.email, u.username AS user_email FROM form_responses r LEFT JOIN users u ON u.id = r.user_id WHERE r.form_id = ?').all(form.id));

/**
 * The automatic reminder: on forms with it turned on that close within a day and are still taking
 * answers, those sent the form who haven't answered get a reminder from its owner, once.
 */
export async function sendDueFormReminders(at = Date.now()) {
  const due = q(`SELECT f.*, u.id AS uid FROM forms f JOIN users u ON u.id = f.owner_id
                 WHERE f.auto_remind = 1 AND f.auto_reminded_at IS NULL AND f.accepting = 1 AND f.close_at IS NOT NULL AND f.close_at > ? AND f.close_at <= ? AND f.invite_base IS NOT NULL`).all(at, at + 864e5);
  let n = 0;
  for (const f of due) {
    const owner = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(f.uid);
    const waiting = invitesOf(f).filter((i) => !i.answered).map((i) => i.email);
    q('UPDATE forms SET auto_reminded_at = ? WHERE id = ?').run(at, f.id); // once, whatever happens
    if (!owner || !waiting.length || !mailEnabled()) continue;
    const failed = await sendFormMail(owner, f.invite_base, parse(f), waiting, { reminder: true }).catch(() => waiting);
    for (const e of waiting.filter((x) => !failed.includes(x))) q('UPDATE form_invites SET reminded_at = ? WHERE form_id = ? AND email = ?').run(at, f.id, e);
    n += waiting.length - failed.length;
  }
  return n;
}

// Colleagues who can edit a form and read its responses with the owner.
q(`CREATE TABLE IF NOT EXISTS form_editors (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (form_id, user_id)
)`).run();
// allow_edit: people can change their response afterwards, with the private link they get on sending it.
// collect_email: "anyone with the link" forms ask for an email address; send_copy: people get their answers by email.
for (const [col, type] of [['collect_email', 'INTEGER NOT NULL DEFAULT 0'], ['send_copy', 'INTEGER NOT NULL DEFAULT 0'], ['allow_edit', 'INTEGER NOT NULL DEFAULT 0'], ['close_at', 'INTEGER'], ['open_at', 'INTEGER'], ['max_responses', 'INTEGER'], ['quiz', 'INTEGER NOT NULL DEFAULT 0'], ['show_score', 'INTEGER NOT NULL DEFAULT 1']]) {
  if (!q('PRAGMA table_info(forms)').all().some((c) => c.name === col)) q(`ALTER TABLE forms ADD COLUMN ${col} ${type}`).run();
}
const MAX_EDITORS = 50;
// People on a form's team who get an email for each new response (each chooses for themselves).
q(`CREATE TABLE IF NOT EXISTS form_email_me (
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (form_id, user_id)
)`).run();

export const TYPES = ['short', 'paragraph', 'choice', 'checkbox', 'dropdown', 'scale', 'date', 'time', 'rating', 'file', 'grid', 'checkgrid', 'rank', 'section'];
const MAX_RANKED = 10; // options a ranking question can have
// Grids: rows (the things asked about) by columns (the choices); one choice per row, or several (checkgrid).
const GRIDS = new Set(['grid', 'checkgrid']);
const MAX_ROWS = 30, MAX_COLUMNS = 20;
const WITH_OPTIONS = new Set(['choice', 'checkbox', 'dropdown', 'rank']); // rank: people put the options in order
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
// linked_sheet: a spreadsheet in the owner's Drive that each response is added to as it arrives.
if (!q('PRAGMA table_info(forms)').all().some((c) => c.name === 'linked_sheet')) q('ALTER TABLE forms ADD COLUMN linked_sheet TEXT').run();
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
      if (type === 'rank') { out.options = out.options.slice(0, MAX_RANKED); if (out.options.length < 2) out.options.push(out.options[0] === 'Option 2' ? 'Option 1' : 'Option 2'); }
      if (raw?.shuffle) out.shuffle = true; // shown in a different order to each person
      if (raw?.other && (type === 'choice' || type === 'checkbox')) out.other = true; // an "Other…" choice people type themselves
      // A picture for an option (choose between logos, products, rooms): { option: Drive picture id }.
      if ((type === 'choice' || type === 'checkbox') && raw?.option_images && typeof raw.option_images === 'object') {
        const imgs = {};
        for (const o of out.options) { const id = raw.option_images[o]; if (typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id)) imgs[o] = id; }
        if (Object.keys(imgs).length) out.option_images = imgs;
      }
      // Limits: how many people can pick an option (a session with 12 seats); a full option can't be chosen.
      if (raw?.limits && typeof raw.limits === 'object' && type !== 'rank') {
        const lim = {};
        for (const o of out.options) { const n = Math.round(Number(raw.limits[o])); if (Number.isFinite(n) && n >= 1) lim[o] = Math.min(n, 100000); }
        if (Object.keys(lim).length) out.limits = lim;
      }
    }
    if (GRIDS.has(type)) {
      const tidy = (l, max, dflt) => { const v = [...new Set((Array.isArray(l) ? l : []).map((o) => String(o ?? '').trim().slice(0, 200)).filter(Boolean))].slice(0, max); return v.length ? v : [dflt]; };
      out.rows = tidy(raw?.rows, MAX_ROWS, 'Row 1');
      out.columns = tidy(raw?.columns, MAX_COLUMNS, 'Column 1');
    }
    // A picture shown with the question (a Drive picture of someone who can edit the form), with its description.
    if (typeof raw?.image === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(raw.image)) {
      out.image = raw.image;
      const alt = String(raw?.image_alt ?? '').trim().slice(0, 300);
      if (alt) out.image_alt = alt;
    }
    if (type === 'section') { delete out.required; return out; } // a new page: its title and help only
    // Response validation; a rule that isn't finished yet (no number typed) is kept out until it is.
    if (CHECKS[type]) { try { const c = cleanCheck(type, raw?.check); if (c) out.check = c; } catch {} }
    if (type === 'file') out.max_files = Math.min(MAX_FILES, Math.max(1, Math.round(Number(raw?.max_files)) || 1)); // up to this many files
    if (type === 'rating') { // 3 to 10 stars (or hearts, or thumbs)
      out.max = Math.min(10, Math.max(3, Math.round(Number(raw?.max)) || 5));
      out.icon = ['star', 'heart', 'thumb'].includes(raw?.icon) ? raw.icon : 'star';
    }
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
      // Answer feedback: a few words shown after submitting, for a right answer and for a wrong one.
      if (out.answer !== undefined) {
        const fb = {};
        for (const k of ['right', 'wrong']) { const t = String(raw.feedback?.[k] ?? '').trim().slice(0, 500); if (t) fb[k] = t; }
        if (Object.keys(fb).length) out.feedback = fb;
      }
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
/** A quiz's score: { score, max, right: { questionId: true | false }, feedback: { questionId: text } } over the questions
 *  with an answer key (feedback: the question's words for a right or a wrong answer, where it has them). */
export function scoreOf(questions, answers) {
  let score = 0, max = 0;
  const right = {}, feedback = {};
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const qu of questions) {
    if (qu.answer === undefined) continue;
    max += qu.points ?? 1;
    const a = answers?.[qu.id];
    const ok = qu.type === 'checkbox'
      ? Array.isArray(a) && a.length === qu.answer.length && qu.answer.every((x) => a.includes(x))
      : qu.type === 'short' ? norm(a) !== '' && norm(a) === norm(qu.answer) : a === qu.answer;
    right[qu.id] = ok;
    const fb = qu.feedback?.[ok ? 'right' : 'wrong'];
    if (fb) feedback[qu.id] = fb;
    if (ok) score += qu.points ?? 1;
  }
  return { score, max, right, feedback };
}
/** The questions as people filling the form in see them: no answer key. */
const withoutKey = (questions) => questions.map(({ answer, points, feedback, ...qu }) => qu);

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
    } else if (GRIDS.has(qu.type)) {
      // { row: column } (or { row: [columns] }), only rows of the question; a required grid needs every row.
      if (a != null && (typeof a !== 'object' || Array.isArray(a))) throw bad(`${name}: answer row by row`);
      const kept = {};
      for (const row of qu.rows) {
        let v = a?.[row];
        if (qu.type === 'checkgrid') {
          v = (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
          if (v.some((x) => !qu.columns.includes(x))) throw bad(`${name}: choose from the columns`);
          v = qu.columns.filter((c) => v.includes(c));
          if (v.length) kept[row] = v;
        } else if (v != null && v !== '') {
          if (!qu.columns.includes(String(v))) throw bad(`${name}: choose from the columns`);
          kept[row] = String(v);
        }
      }
      const done = Object.keys(kept).length;
      if (qu.required && done && done < qu.rows.length) throw bad(`${name}: answer every row`);
      a = done ? kept : undefined;
    } else if (qu.type === 'rank') {
      // Every option once, first choice first.
      if (a == null || a === '' || (Array.isArray(a) && !a.length)) a = undefined;
      else {
        if (!Array.isArray(a)) throw bad(`${name}: put the options in order`);
        a = a.map(String);
        if (a.length !== qu.options.length || new Set(a).size !== a.length || a.some((x) => !qu.options.includes(x))) throw bad(`${name}: put every option in order, once each`);
      }
    } else if (qu.type === 'checkbox') {
      a = (Array.isArray(a) ? a : a == null || a === '' ? [] : [a]).map((x) => String(x).trim()).filter(Boolean);
      const others = [...new Set(a.filter((x) => !qu.options.includes(x)))];
      if (others.length > (qu.other ? 1 : 0)) throw bad(`${name}: choose from the options`);
      if (others.some((x) => x.length > 200)) throw bad(`${name}: that answer is too long`);
      a = [...qu.options.filter((o) => a.includes(o)), ...others]; // the form's order, no repeats; "Other" last
      if (!a.length) a = undefined;
    } else if (qu.type === 'scale' || qu.type === 'rating') {
      if (a === '' || a == null) a = undefined;
      else {
        a = Number(a);
        if (!Number.isInteger(a) || a < 1 || a > qu.max) throw bad(`${name}: pick a number from 1 to ${qu.max}`);
      }
    } else {
      a = a == null ? '' : String(a).trim();
      if (WITH_OPTIONS.has(qu.type) && a && !qu.options.includes(a) && !(qu.other && qu.type === 'choice')) throw bad(`${name}: choose from the options`);
      if (qu.type === 'date' && a && !/^\d{4}-\d{2}-\d{2}$/.test(a)) throw bad(`${name}: enter a date`);
      if (qu.type === 'time' && a && !/^([01]\d|2[0-3]):[0-5]\d$/.test(a)) throw bad(`${name}: enter a time`);
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

const parse = (f) => ({ ...f, questions: JSON.parse(f.questions || '[]'), accepting: !!f.accepting, one_per_person: !!f.one_per_person, notify: !!f.notify, quiz: !!f.quiz, show_score: !!f.show_score, allow_edit: !!f.allow_edit, collect_email: !!f.collect_email, send_copy: !!f.send_copy, auto_remind: !!f.auto_remind });
const responsesOf = (formId) => q(`SELECT r.id, r.answers, r.created_at, r.updated_at, r.email, u.name AS user_name, u.username AS user_email
                                   FROM form_responses r LEFT JOIN users u ON u.id = r.user_id WHERE r.form_id = ? ORDER BY r.created_at`).all(formId)
  .map((r) => ({ id: r.id, created_at: r.created_at, ...(r.updated_at && { updated_at: r.updated_at }), ...(r.email && { email: r.email }), user: r.user_email ? { name: r.user_name, email: r.user_email } : null, answers: JSON.parse(r.answers) }));

/** The table of responses: a header row, then one row per response. */
export function responseTable(form, responses, { withPeople = form.audience === 'org' || responses.some((r) => r.user) } = {}) {
  const quiz = !!form.quiz;
  const emails = !withPeople && responses.some((r) => r.email);
  // One column per question; a grid gets one per row, "Question [Row]".
  const cols = form.questions.filter((qu) => qu.type !== 'section').flatMap((qu) => (GRIDS.has(qu.type)
    ? qu.rows.map((row) => ({ title: `${qu.title || 'Untitled question'} [${row}]`, of: (ans) => ans[qu.id]?.[row] }))
    : [{ title: qu.title || 'Untitled question', of: qu.type === 'rank' ? (ans) => ans[qu.id]?.map((o, k) => `${k + 1}. ${o}`) : (ans) => ans[qu.id] }]));
  const head = ['Submitted', ...(withPeople ? ['Name', 'Email'] : []), ...(emails ? ['Email'] : []), ...(quiz ? ['Score'] : []), ...cols.map((c) => c.title)];
  const rows = responses.map((r) => {
    const sc = quiz ? scoreOf(form.questions, r.answers) : null;
    return [new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19),
      ...(withPeople ? [r.user?.name || '', r.user?.email || ''] : []), ...(emails ? [r.email || ''] : []), ...(quiz ? [`${sc.score} / ${sc.max}`] : []), ...cols.map((c) => asText(c.of(r.answers)))];
  });
  return [head, ...rows];
}

const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** The linked spreadsheet, if it's still there (not deleted or in the bin). */
const linkedSheetOf = (f) => (f.linked_sheet && q("SELECT id, name FROM files WHERE id = ? AND kind = 'sheet' AND trashed = 0").get(f.linked_sheet)) || null;
const cellOf = (v) => (/^[=]/.test(v) ? `'${v}` : v);

/**
 * Put a response in the form's linked spreadsheet, on its first sheet: a new row at the bottom, or
 * (changed afterwards) the row it was given. Columns are found by their heading in the first row, so
 * people can move them; questions added later get a new column at the end.
 */
export function addToLinkedSheet(form, responseId, { changedRow = false } = {}) {
  if (!linkedSheetOf(form)) return;
  const resp = responsesOf(form.id).find((x) => x.id === responseId);
  if (!resp) return;
  const [head, row] = responseTable(form, [resp], { withPeople: form.audience === 'org' });
  changeSheet(form.linked_sheet, (json) => {
    const sheets = json.sheets?.length ? json.sheets : [{ name: 'Responses', cells: {} }];
    const sheet = { ...sheets[0], cells: { ...(sheets[0].cells || {}) } };
    const cells = sheet.cells;
    let lastRow = 1;
    for (const k of Object.keys(cells)) { const m = /^[A-Z]+(\d+)$/.exec(k); if (m && cells[k] !== '') lastRow = Math.max(lastRow, Number(m[1])); }
    let lastCol = -1;
    const colOf = new Map();
    for (let c = 0; c < 200; c++) { const h = cells[`${colName(c)}1`]; if (h !== undefined && h !== '') { lastCol = c; if (!colOf.has(String(h))) colOf.set(String(h), c); } }
    head.forEach((h) => { if (!colOf.has(h)) { lastCol += 1; colOf.set(h, lastCol); cells[`${colName(lastCol)}1`] = h; } });
    // Its row: the one with the same id (column of ids is kept out of sight: Submitted + seconds can repeat).
    let r = lastRow + 1;
    if (changedRow) {
      const idCol = colOf.get('Response ID');
      for (let i = 2; i <= lastRow; i++) if (idCol !== undefined && cells[`${colName(idCol)}${i}`] === resp.id) { r = i; break; }
    }
    if (!colOf.has('Response ID')) { lastCol += 1; colOf.set('Response ID', lastCol); cells[`${colName(lastCol)}1`] = 'Response ID'; }
    head.forEach((h, i) => { const k = `${colName(colOf.get(h))}${r}`; if (row[i] === '') delete cells[k]; else cells[k] = cellOf(row[i]); });
    cells[`${colName(colOf.get('Response ID'))}${r}`] = resp.id;
    return { ...json, sheets: [sheet, ...sheets.slice(1)] };
  }, form.owner_id);
}

const countOf = (formId) => q('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(formId).n;
const editorsOf = (formId) => q(`SELECT u.id, u.name, u.username AS email FROM form_editors e JOIN users u ON u.id = e.user_id
                                 WHERE e.form_id = ? ORDER BY e.added_at`).all(formId);
/** Everyone who works on the form: its owner and its editors. */
export const teamOf = (f) => [f.owner_id, ...editorsOf(f.id).map((u) => u.id)];

/** Why a form isn't taking answers right now, or null when it is. */
export function closedReason(f, t = Date.now(), count = null) {
  if (!f.accepting) return 'closed';
  if (f.open_at && f.open_at > t) return 'notyet'; // opens by itself later
  if (f.close_at && f.close_at <= t) return 'ended';
  if (f.max_responses && (count ?? countOf(f.id)) >= f.max_responses) return 'full';
  return null;
}
/** For questions with option limits: how many places each limited option has left ({ qid: { option: n } }). */
export function placesLeft(formId, questions, exceptResponseId = null) {
  const limited = questions.filter((qu) => qu.limits);
  if (!limited.length) return {};
  const used = Object.fromEntries(limited.map((qu) => [qu.id, {}]));
  for (const r of q('SELECT id, answers FROM form_responses WHERE form_id = ?').all(formId)) {
    if (r.id === exceptResponseId) continue;
    let a; try { a = JSON.parse(r.answers); } catch { continue; }
    for (const qu of limited) for (const v of [].concat(a[qu.id] ?? [])) if (typeof v === 'string') used[qu.id][v] = (used[qu.id][v] || 0) + 1;
  }
  return Object.fromEntries(limited.map((qu) => [qu.id, Object.fromEntries(Object.entries(qu.limits).map(([o, n]) => [o, Math.max(0, n - (used[qu.id][o] || 0))]))]));
}
/** Refuse answers that pick an option with no places left. */
function checkPlaces(formId, questions, answers, exceptResponseId = null, before = {}) {
  const left = placesLeft(formId, questions, exceptResponseId);
  for (const [qid, opts] of Object.entries(left)) {
    for (const v of [].concat(answers[qid] ?? [])) {
      if (opts[v] === 0 && ![].concat(before[qid] ?? []).includes(v)) throw new HttpError(409, `“${v}” is full: choose another`);
    }
  }
}

const CLOSED_TEXT = { notyet: 'This form isn\'t open yet', closed: 'This form is no longer accepting responses', ended: 'This form closed', full: 'This form has all the responses it needs' };

/** A form you own or edit (ownerOnly: you must own it). */
function ownForm(id, user, { ownerOnly = false } = {}) {
  const f = q('SELECT f.*, u.name AS owner_name, u.username AS owner_email FROM forms f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(String(id));
  const mine = f && f.owner_id === user.id;
  if (!f || (!mine && !q('SELECT 1 FROM form_editors WHERE form_id = ? AND user_id = ?').get(f.id, user.id))) throw notFound('Form not found');
  if (ownerOnly && !mine) throw forbidden('Only the owner can do that');
  return { ...parse(f), role: mine ? 'owner' : 'editor', editors: editorsOf(f.id), owner: { id: f.owner_id, name: f.owner_name, email: f.owner_email },
    email_me: !!q('SELECT 1 FROM form_email_me WHERE form_id = ? AND user_id = ?').get(f.id, user.id), mail: mailEnabled() };
}
const changed = (f, by) => sendTo(teamOf(f).filter((x) => x !== by), { type: 'form-changed', form_id: f.id });
const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/**
 * A picture on one of the form's questions, for whoever can open the form (people filling it in too):
 * only pictures it uses, owned by its owner or an editor. `ownerSeesNew`: the person who just added one
 * sees it before the form is saved with it.
 */
function sendPicture(form, picId, res, ownerSeesNew = null) {
  const pic = String(picId);
  const used = form.questions.some((qu) => qu.image === pic || Object.values(qu.option_images || {}).includes(pic));
  const file = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(pic);
  const team = teamOf(form);
  if (!file || !PICTURE_TYPES.test(file.mime || '') || !team.includes(file.owner_id) || !(used || (ownerSeesNew && file.owner_id === ownerSeesNew))) throw notFound('Picture not found');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.sendFile(path.join(FILES_DIR, file.storage));
}

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

  // Forms to start from: the gallery under New form.
  r.get('/templates', (req, res) => res.json(templateList()));

  r.post('/', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM forms WHERE owner_id = ?').get(req.user.id).n >= MAX_FORMS) throw bad(`You can have up to ${MAX_FORMS} forms`);
    // From a template: its title, description, questions, message after sending and settings.
    const tpl = req.body?.template ? templateById(String(req.body.template)) : null;
    if (req.body?.template && !tpl) throw notFound('No such template');
    const title = str(req.body?.title ?? '', { max: 200 }) || tpl?.title || 'Untitled form';
    const id = uid();
    const t = now();
    const questions = cleanQuestions(tpl ? tpl.questions : req.body?.questions ?? [{ type: 'choice', title: '', options: ['Option 1'] }]);
    tx(() => {
      q(`INSERT INTO forms (id, org_id, owner_id, token, title, questions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.user.org_id, req.user.id, crypto.randomBytes(12).toString('base64url'), title, JSON.stringify(questions), t, t);
      if (tpl) {
        const st = tpl.settings || {};
        q('UPDATE forms SET description = ?, confirmation = ?, quiz = ?, show_score = ?, one_per_person = ? WHERE id = ?')
          .run(tpl.description || '', tpl.confirmation || '', st.quiz ? 1 : 0, st.show_score === false ? 0 : 1, st.one_per_person ? 1 : 0, id);
      }
    });
    res.status(201).json(ownForm(id, req.user));
  });

  r.get('/:id/pictures/:pic', (req, res) => sendPicture(ownForm(req.params.id, req.user), req.params.pic, res, req.user.id));

  r.get('/:id', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const responses = countOf(f.id);
    res.json({ ...f, responses, closed: closedReason(f, Date.now(), responses), linked_sheet: linkedSheetOf(f) });
  });

  // "Email me each response": for the owner and each editor, for themselves.
  r.put('/:id/email-me', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    if (req.body?.on) q('INSERT OR IGNORE INTO form_email_me (form_id, user_id) VALUES (?, ?)').run(f.id, req.user.id);
    else q('DELETE FROM form_email_me WHERE form_id = ? AND user_id = ?').run(f.id, req.user.id);
    res.json({ email_me: !!req.body?.on });
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
      allow_edit: 'allow_edit' in b ? !!b.allow_edit : f.allow_edit,
      collect_email: 'collect_email' in b ? !!b.collect_email : f.collect_email,
      send_copy: 'send_copy' in b ? !!b.send_copy : f.send_copy,
      close_at: 'close_at' in b ? (b.close_at == null || b.close_at === '' ? null : Number(b.close_at)) : f.close_at,
      open_at: 'open_at' in b ? (b.open_at == null || b.open_at === '' ? null : Number(b.open_at)) : f.open_at,
      auto_remind: 'auto_remind' in b ? !!b.auto_remind : !!f.auto_remind,
      max_responses: 'max_responses' in b ? (b.max_responses == null || b.max_responses === '' ? null : Number(b.max_responses)) : f.max_responses,
    };
    if (next.close_at !== null && (!Number.isFinite(next.close_at) || next.close_at < 0)) throw bad('close_at must be a time');
    if (next.open_at !== null && (!Number.isFinite(next.open_at) || next.open_at < 0)) throw bad('open_at must be a time');
    if (next.open_at !== null && next.close_at !== null && next.open_at >= next.close_at) throw bad('The form has to open before it closes');
    if (next.max_responses !== null && (!Number.isInteger(next.max_responses) || next.max_responses < 1 || next.max_responses > MAX_RESPONSES)) {
      throw bad(`The response limit must be from 1 to ${MAX_RESPONSES}`);
    }
    if (next.audience === 'public' && f.audience !== 'public' && !req.user.allow_links) throw forbidden('Your company has turned off links for people outside it');
    q(`UPDATE forms SET title = ?, description = ?, questions = ?, audience = ?, accepting = ?, one_per_person = ?, confirmation = ?, notify = ?,
       close_at = ?, open_at = ?, max_responses = ?, quiz = ?, show_score = ?, allow_edit = ?, collect_email = ?, send_copy = ?, auto_remind = ?,
       auto_reminded_at = CASE WHEN ? THEN NULL ELSE auto_reminded_at END, updated_at = ? WHERE id = ?`)
      .run(next.title, next.description, JSON.stringify(next.questions), next.audience, next.accepting ? 1 : 0, next.one_per_person ? 1 : 0, next.confirmation, next.notify ? 1 : 0,
        next.close_at, next.open_at, next.max_responses, next.quiz ? 1 : 0, next.show_score ? 1 : 0, next.allow_edit ? 1 : 0, next.collect_email ? 1 : 0, next.send_copy ? 1 : 0, next.auto_remind ? 1 : 0,
        next.close_at !== f.close_at ? 1 : 0, now(), f.id); // a new closing date: the automatic reminder can go again
    changed(f, req.user.id);
    const out = ownForm(f.id, req.user);
    res.json({ ...out, responses: countOf(f.id), closed: closedReason(out) });
  });

  // Send the form by email (from you), and see who of them has answered.
  r.get('/:id/invites', (req, res) => res.json(invitesOf(ownForm(req.params.id, req.user))));
  const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
  const sendInvites = (req, form, emails, opts) => sendFormMail(req.user, baseUrlOf(req), form, emails, opts);
  r.post('/:id/send', async (req, res) => {
    const form = ownForm(req.params.id, req.user);
    const typed = [...new Set(String(req.body?.to || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (!typed.length) throw bad('Add at least one email address');
    if (typed.length > 200) throw bad('At most 200 people at a time');
    const wrong = typed.find((e) => !EMAIL.test(e));
    if (wrong) throw bad(`“${wrong}” isn't an email address`);
    const emails = expandAddresses(typed, req.user.org_id); // a group's address: each of its people
    if (emails.length > 500) throw bad('That reaches more than 500 people');
    q('UPDATE forms SET invite_base = ? WHERE id = ?').run(baseUrlOf(req), form.id);
    if (!form.accepting) throw bad('The form isn\'t accepting responses: turn that on first');
    const message = str(req.body?.message ?? '', { name: 'Message', max: 2000 }) || null;
    const failed = await sendInvites(req, form, emails, { message });
    const t = now();
    for (const e of emails.filter((x) => !failed.includes(x))) q('INSERT INTO form_invites (form_id, email, sent_at) VALUES (?, ?, ?) ON CONFLICT(form_id, email) DO UPDATE SET sent_at = excluded.sent_at').run(form.id, e, t);
    res.json({ sent: emails.length - failed.length, failed, invites: invitesOf(form) });
  });
  // A reminder to those it was sent to who haven't answered yet.
  r.post('/:id/remind', async (req, res) => {
    const form = ownForm(req.params.id, req.user);
    if (!form.accepting) throw bad('The form isn\'t accepting responses');
    const waiting = invitesOf(form).filter((i) => !i.answered).map((i) => i.email);
    if (!waiting.length) return res.json({ sent: 0, failed: [], invites: invitesOf(form) });
    const failed = await sendInvites(req, form, waiting, { reminder: true, message: str(req.body?.message ?? '', { name: 'Message', max: 2000 }) || null });
    const t = now();
    for (const e of waiting.filter((x) => !failed.includes(x))) q('UPDATE form_invites SET reminded_at = ? WHERE form_id = ? AND email = ?').run(t, form.id, e);
    res.json({ sent: waiting.length - failed.length, failed, invites: invitesOf(form) });
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
    q('DELETE FROM form_email_me WHERE form_id = ? AND user_id = ?').run(f.id, req.params.userId);
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

  r.get('/:id/responses.xlsx', async (req, res) => {
    const f = ownForm(req.params.id, req.user);
    sendXlsx(res, `${f.title.replace(/[^\w .-]+/g, '').trim() || 'form'} responses.xlsx`, await excelFromTable('Responses', responseTable(f, responsesOf(f.id))));
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
  // With { link: true } it stays linked: each new response is added to it as it arrives.
  r.post('/:id/sheet', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    const link = !!req.body?.link;
    const already = link && linkedSheetOf(f);
    if (already) return res.json({ id: already.id, linked: true });
    const table = responseTable(f, responsesOf(f.id), { withPeople: f.audience === 'org' || undefined });
    if (link) { table[0].push('Response ID'); responsesOf(f.id).forEach((x, i) => table[i + 1].push(x.id)); }
    const cells = {};
    table.forEach((row, ri) => row.forEach((v, ci) => { if (v !== '') cells[`${colName(ci)}${ri + 1}`] = /^[=]/.test(v) ? `'${v}` : v; }));
    const colWidths = {};
    table[0].forEach((h, ci) => { colWidths[colName(ci)] = ci === 0 ? 160 : Math.min(320, Math.max(100, h.length * 8)); });
    const fileId = insertFile({ owner: req.user.id, parentId: null, name: `${f.title} (responses)`.slice(0, 200), kind: 'sheet',
      content: JSON.stringify({ sheets: [{ name: 'Responses', cells, colWidths, frozen: { rows: 1 } }] }) });
    if (link) {
      q('UPDATE forms SET linked_sheet = ? WHERE id = ?').run(fileId, f.id);
      changed(f, req.user.id);
    }
    res.status(201).json({ id: fileId, linked: link });
  });
  r.delete('/:id/sheet', (req, res) => {
    const f = ownForm(req.params.id, req.user);
    q('UPDATE forms SET linked_sheet = NULL WHERE id = ?').run(f.id);
    changed(f, req.user.id);
    res.json({ ok: true });
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

const baseUrlOf = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
/** "Question: answer" lines for a response, as people see it in their copy. */
export function answersText(questions, answers) {
  const lines = [];
  for (const qu of questions) {
    if (qu.type === 'section') { lines.push('', `— ${qu.title || 'Section'} —`); continue; }
    if (!(qu.id in answers)) continue;
    const a = answers[qu.id];
    if (GRIDS.has(qu.type)) { lines.push(`${qu.title || 'Untitled question'}:`, ...qu.rows.filter((row) => row in a).map((row) => `  ${row}: ${[a[row]].flat().join(', ')}`)); continue; }
    lines.push(`${qu.title || 'Untitled question'}: ${Array.isArray(a) ? a.map((x) => (x && typeof x === 'object' ? x.name : x)).join(', ') : a}`);
  }
  return lines.join('\n').replace(/^\n+/, '');
}
/** The email a form's owner or editor gets for a new response: { subject, text }. */
export function responseEmail(form, answers, { who = null, email = null, score = null, link = '' } = {}) {
  const from = who || email;
  return {
    subject: `New response to “${form.title}”${from ? ` from ${from}` : ''}`,
    text: [`A new response to “${form.title}”${who ? ` from ${who}` : email ? ` (${email})` : ''}:`, '', answersText(form.questions, answers),
      ...(score ? ['', `Score: ${score.score} / ${score.max}`] : []),
      ...(link ? ['', `All responses: ${link}`] : []),
      '', 'You get these because you turned on “Email me each response” in the form\'s settings.'].join('\n'),
  };
}
/** Email each team member who asked for it about a new response (not whoever sent it). */
function emailTeam(form, answers, { by = null, who = null, email = null, link = '' } = {}) {
  if (!mailEnabled()) return;
  const team = new Set(teamOf(form));
  const people = q('SELECT u.id, u.username, u.name FROM form_email_me m JOIN users u ON u.id = m.user_id WHERE m.form_id = ? AND u.disabled = 0').all(form.id)
    .filter((u) => team.has(u.id) && u.id !== by);
  if (!people.length) return;
  const score = form.quiz ? scoreOf(form.questions, answers) : null;
  const { subject, text } = responseEmail(form, answers, { who, email, score, link });
  for (const u of people) {
    smtpFor(u).sendMail({ from: { name: 'Workspace Forms', address: u.username }, to: u.username, subject, text })
      .catch((e) => console.error('[forms] response email:', e.message));
  }
}
/** Email someone their answers, from the form's owner (when this server has email). */
/** The text of someone's copy of their response: their answers, their score (with each question's ✓ or ✗ and
 *  its feedback, for a quiz showing scores) and the link to change it. */
export function copyText(form, answers, result, editLink) {
  const marks = result ? form.questions.filter((qu) => qu.id in (result.right || {}))
    .map((qu) => `${result.right[qu.id] ? '✓' : '✗'} ${qu.title || 'Untitled question'}${result.feedback?.[qu.id] ? ` — ${result.feedback[qu.id]}` : ''}`) : [];
  return [`Thanks for filling in “${form.title}”. Here's what you sent:`, '', answersText(form.questions, answers),
    ...(result ? ['', `Your score: ${result.score} / ${result.max}`, ...marks] : []),
    ...(editLink ? ['', `To change your answers: ${editLink}`] : [])].join('\n');
}
function sendCopy(form, to, answers, result, editLink) {
  if (!mailEnabled()) return;
  const owner = q('SELECT id, username, name FROM users WHERE id = ?').get(form.owner_id);
  const text = copyText(form, answers, result, editLink);
  smtpFor(owner).sendMail({ from: { name: owner.name, address: owner.username }, to, subject: `Your response to “${form.title}”`, text })
    .catch((e) => console.error('[forms] copy of a response:', e.message));
}

export function publicFormRoutes() {
  const r = Router();
  r.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });

  r.get('/:token', (req, res) => {
    const { form, user, f } = openForm(req);
    const mine = !!user && form.audience === 'org' && form.one_per_person && q('SELECT edit_key FROM form_responses WHERE form_id = ? AND user_id = ? ORDER BY created_at DESC').get(form.id, user.id);
    const answered = !!mine;
    const closed = closedReason(form);
    const left = placesLeft(form.id, form.questions);
    const team = !!user && teamOf(form).includes(user.id);
    res.json({ ...(Object.keys(left).length && { left }), title: form.title, description: form.description, questions: withoutKey(form.questions), quiz: form.quiz, accepting: !closed, closed, closed_text: closed ? CLOSED_TEXT[closed] : null, ...(closed === 'notyet' && { opens_at: form.open_at }), audience: form.audience,
      one_per_person: form.audience === 'org' && form.one_per_person, answered, org_name: f.org_name, allow_edit: form.allow_edit, collect_email: form.audience === 'public' && form.collect_email, send_copy: form.send_copy && mailEnabled(), ...(mine && form.allow_edit && mine.edit_key && { my_edit_key: mine.edit_key }),
      you: form.audience === 'org' ? { name: user.name, email: user.email } : null, is_owner: team,
      // For a card when the link is pasted in Chat: whether you've sent a response, and (for its team) how many came.
      responded: !!user && !!q('SELECT 1 FROM form_responses WHERE form_id = ? AND user_id = ?').get(form.id, user.id),
      ...(team && { responses: q('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').get(form.id).n }) });
  });

  r.get('/:token/pictures/:pic', (req, res) => { const { form } = openForm(req); sendPicture(form, req.params.pic, res); });

  // A file for a file upload question (?name=): kept until the response is sent. Returns { id, name, size }.
  r.post('/:token/upload', async (req, res) => {
    const { form } = openForm(req);
    const shut = closedReason(form);
    if (shut) throw new HttpError(409, CLOSED_TEXT[shut]);
    if (!form.questions.some((qu) => qu.type === 'file')) throw bad('This form has no file questions');
    if (form.audience === 'public') limit(req.ip);
    dropStaleUploads();
    const name = cleanName(String(req.query.name || 'file'));
    // Files go to the form owner's Drive: their storage limit too (a full one says so, not "too large").
    const { storage, size } = await receiveUpload(req, form.org_id, MAX_FILE_BYTES, form.owner_id).catch((e) => { throw e.status === 413 && /too large/i.test(e.message) ? new HttpError(413, 'Files can be up to 10 MB') : e; });
    const id = crypto.randomBytes(16).toString('base64url');
    q('INSERT INTO form_uploads (id, form_id, storage, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, form.id, storage, name, size, now());
    res.status(201).json({ id, name, size });
  });

  r.post('/:token', (req, res) => {
    const { form, user } = openForm(req);
    const shut = closedReason(form);
    if (shut) throw new HttpError(409, CLOSED_TEXT[shut]);
    const answers = checkAnswers(form.questions, req.body?.answers);
    // Their email address: from their account on company forms; asked for on others when collected.
    let email = form.audience === 'org' ? user.username : null;
    if (form.audience === 'public' && form.collect_email) {
      email = String(req.body?.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw bad('Your email: enter your email address');
    }
    // File answers: uploads to this form that haven't been used.
    const fileQs = form.questions.filter((qu) => qu.type === 'file' && answers[qu.id]);
    for (const qu of fileQs) for (const up of answers[qu.id]) {
      if (!q('SELECT 1 FROM form_uploads WHERE id = ? AND form_id = ?').get(up, form.id)) throw bad(`${qu.title || 'A file question'}: upload the file again`);
    }
    if (form.audience === 'public') limit(req.ip);
    const id = uid();
    const editKey = form.allow_edit ? crypto.randomBytes(18).toString('base64url') : null;
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
      checkPlaces(form.id, form.questions, answers);
      q('INSERT INTO form_responses (id, form_id, user_id, answers, created_at, edit_key, email) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, form.id, form.audience === 'org' ? user.id : null, JSON.stringify(answers), now(), editKey, form.audience === 'public' ? email : null);
    });
    const team = teamOf(form);
    sendTo(team, { type: 'form-response', form_id: form.id });
    try { addToLinkedSheet(form, id); } catch (e) { console.error('[forms] linked sheet:', e.message); }
    if (form.notify) {
      bell(team.filter((x) => x !== user?.id), { kind: 'form', title: `New response to “${form.title}”`, body: form.audience === 'org' ? `From ${user.name}` : null, link: `/forms/${form.id}?tab=responses`, actor: user?.id || null });
    }
    const result = form.quiz && form.show_score ? scoreOf(form.questions, answers) : null;
    emailTeam(form, answers, { by: user?.id || null, who, email: form.audience === 'public' ? email : null, link: `${baseUrlOf(req)}/forms/${form.id}?tab=responses` });
    if (form.send_copy && email) sendCopy(form, email, answers, result, editKey ? `${baseUrlOf(req)}/f/${form.token}?edit=${editKey}` : null);
    res.status(201).json({ ok: true, confirmation: form.confirmation || '', ...(editKey && { edit_key: editKey }), ...(form.send_copy && email && mailEnabled() && { copy_to: email }), ...(result && { score: result.score, max: result.max, right: result.right, feedback: result.feedback }) });
  });

  // Changing a response afterwards (when the form allows it), with its private key. File answers stay
  // as they were sent. A company form's response can only be changed by whoever sent it.
  const editable = (req) => {
    const { form, user } = openForm(req);
    const resp = form.allow_edit && q('SELECT * FROM form_responses WHERE form_id = ? AND edit_key = ?').get(form.id, String(req.params.key));
    if (!resp || (form.audience === 'org' && resp.user_id !== user.id)) throw notFound('This response can no longer be changed');
    return { form, user, resp };
  };
  r.get('/:token/response/:key', (req, res) => {
    const { form, resp } = editable(req);
    const answers = JSON.parse(resp.answers);
    for (const qu of form.questions) if (qu.type === 'file') delete answers[qu.id];
    res.json({ answers, files: Object.fromEntries(form.questions.filter((qu) => qu.type === 'file' && JSON.parse(resp.answers)[qu.id]).map((qu) => [qu.id, JSON.parse(resp.answers)[qu.id].map((x) => x.name)])) });
  });
  r.put('/:token/response/:key', (req, res) => {
    const { form, user, resp } = editable(req);
    if (!form.accepting || (form.close_at && Date.now() >= form.close_at)) throw new HttpError(409, 'This form is no longer accepting responses, so the response can\'t be changed');
    const old = JSON.parse(resp.answers);
    // File questions keep what was sent (and aren't checked again).
    const asked = form.questions.map((qu) => (qu.type === 'file' ? { ...qu, required: false } : qu));
    const incoming = { ...(req.body?.answers || {}) };
    for (const qu of form.questions) if (qu.type === 'file') delete incoming[qu.id];
    const answers = checkAnswers(asked, incoming);
    for (const qu of form.questions) if (qu.type === 'file' && old[qu.id]) answers[qu.id] = old[qu.id];
    tx(() => {
      checkPlaces(form.id, form.questions, answers, resp.id, old); // keeping their own place is fine
      q('UPDATE form_responses SET answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(answers), now(), resp.id);
    });
    try { addToLinkedSheet(form, resp.id, { changedRow: true }); } catch (e) { console.error('[forms] linked sheet:', e.message); }
    sendTo(teamOf(form), { type: 'form-response', form_id: form.id });
    if (form.notify) bell(teamOf(form).filter((x) => x !== user?.id), { kind: 'form', title: `A response to “${form.title}” was changed`, body: form.audience === 'org' ? `By ${user.name}` : null, link: `/forms/${form.id}?tab=responses`, actor: user?.id || null });
    const result = form.quiz && form.show_score ? scoreOf(form.questions, answers) : null;
    res.json({ ok: true, confirmation: form.confirmation || '', edit_key: resp.edit_key, ...(result && { score: result.score, max: result.max, right: result.right, feedback: result.feedback }) });
  });
  return r;
}
