// Adding many people at once from a CSV file (Admin → Users → Import): one row per person, with a
// name, an address (or just the part before @, on the domain chosen), and optionally a password and
// whether they're an admin. Checked first; only good rows are created. People without a password
// get one made up, shown once to the admin to pass on.
import crypto from 'node:crypto';
import { rulesOf, passwordProblem } from './passwordrules.js';
import { parseCsv } from './contactfiles.js';
import { validAddress } from './tenancy.js';
import { q } from './db.js';

export const MAX_IMPORT_USERS = 500;
const COLS = {
  name: ['name', 'full name', 'display name'],
  first: ['first name', 'given name', 'firstname'],
  last: ['last name', 'surname', 'family name', 'lastname'],
  email: ['email', 'email address', 'e-mail', 'address', 'username', 'user'],
  password: ['password', 'initial password'],
  admin: ['admin', 'is admin', 'role', 'administrator'],
  title: ['job title', 'title', 'position'],
  department: ['department', 'dept', 'team'],
  phone: ['work phone', 'phone', 'telephone', 'phone number'],
  manager: ['manager', 'manager email', 'reports to'],
};
const PHONE = /^[+()\d\s.\-/x]+$/i;
const YES = /^(yes|y|true|1|admin|administrator)$/i;

/** A password that's easy to read out and type: three groups of four letters and digits. */
export function readablePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  const pw = [0, 4, 8].map((i) => [...b.subarray(i, i + 4)].map((x) => abc[x % abc.length]).join('')).join('-');
  // Letters, a number and a symbol (the dashes), so it meets any company's rules.
  const withDigit = /\d/.test(pw) ? pw : `${pw.slice(0, -1)}${2 + (b[0] % 8)}`;
  return /[a-z]/.test(withDigit) ? withDigit : `k${withDigit.slice(1)}`;
}

/**
 * The people in a CSV, checked against the company: [{ line, name, email, password, admin, error }].
 * `domain` is used for addresses given without one.
 */
export function planImport(text, { orgId, domain }) {
  const rows = parseCsv(text);
  if (!rows.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k) => { for (const n of COLS[k]) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const at = Object.fromEntries(Object.keys(COLS).map((k) => [k, col(k)]));
  // Email always; a name for new people (a file that only updates details can leave it out).
  if (at.email < 0) throw Object.assign(new Error('The first row must name the columns: Name (or First name and Last name) and Email'), { status: 400 });
  if (rows.length - 1 > MAX_IMPORT_USERS) throw Object.assign(new Error(`At most ${MAX_IMPORT_USERS} people at a time`), { status: 400 });
  const seen = new Set();
  return rows.slice(1).map((r, i) => {
    const get = (k) => (at[k] >= 0 ? String(r[at[k]] ?? '').trim() : '');
    const name = get('name') || [get('first'), get('last')].filter(Boolean).join(' ');
    let email = get('email').toLowerCase();
    if (email && !email.includes('@') && domain) email = `${email}@${domain}`;
    let manager = get('manager').toLowerCase();
    if (manager && !manager.includes('@') && domain) manager = `${manager}@${domain}`;
    const out = { line: i + 2, name, email, password: get('password') || null, admin: YES.test(get('admin')),
      job_title: get('title').slice(0, 100) || null, department: get('department').slice(0, 100) || null, work_phone: get('phone') || null, manager: manager || null };
    try {
      if (out.work_phone && (out.work_phone.length > 40 || !PHONE.test(out.work_phone))) throw new Error(`“${out.work_phone}” isn't a phone number`);
      if (out.manager && out.manager === email) throw new Error('Someone can’t be their own manager');
      // Someone already in the company: their details are brought up to date (not their password or role).
      const existing = email.includes('@') && q('SELECT id, name FROM users WHERE username = ? AND org_id = ?').get(email, orgId);
      if (existing) {
        if (seen.has(email)) throw new Error(`${email} is in the file twice`);
        out.update = existing.id;
        out.password = null;
        seen.add(email);
        return out;
      }
      if (!name) throw new Error('No name');
      if (name.length > 100) throw new Error('The name is too long');
      if (!email) throw new Error('No email address');
      const [local, d] = email.split('@');
      out.email = validAddress(local, d, orgId);
      if (seen.has(out.email)) throw new Error(`${out.email} is in the file twice`);
      if (out.password !== null) { const problem = passwordProblem(out.password, rulesOf(orgId), { email: out.email, name }); if (problem) throw new Error(problem); }
    } catch (e) { out.error = e.message; }
    seen.add(out.email);
    return out;
  });
}

// ---- the other way: the company's people as a CSV (for audits, payroll, moving elsewhere) ----
// Cells that a spreadsheet would read as a formula (=, +, -, @ first) get a leading ' so they stay text.
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');

/** Rows of { name, username, is_admin, disabled, two_factor, storage_used, created_at, last_active }. */
export function usersCsv(rows) {
  const head = ['Name', 'Email', 'Administrator', 'Status', 'Two-step verification', 'Drive storage (MB)', 'Created', 'Last active', 'Job title', 'Department', 'Work phone', 'Manager'];
  const lines = rows.map((u) => [u.name, u.username, u.is_admin ? 'yes' : 'no', u.disabled ? 'disabled' : 'active', u.two_factor ? 'on' : 'off',
    (u.storage_used / 1048576).toFixed(1), day(u.created_at), day(u.last_active), u.job_title, u.department, u.work_phone, u.manager_email]);
  return `﻿${[head, ...lines].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
