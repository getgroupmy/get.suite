// Adding many people at once from a CSV file (Admin → Users → Import): one row per person, with a
// name, an address (or just the part before @, on the domain chosen), and optionally a password and
// whether they're an admin. Checked first; only good rows are created. People without a password
// get one made up, shown once to the admin to pass on.
import crypto from 'node:crypto';
import { parseCsv } from './contactfiles.js';
import { validAddress } from './tenancy.js';

export const MAX_IMPORT_USERS = 500;
const COLS = {
  name: ['name', 'full name', 'display name'],
  first: ['first name', 'given name', 'firstname'],
  last: ['last name', 'surname', 'family name', 'lastname'],
  email: ['email', 'email address', 'e-mail', 'address', 'username', 'user'],
  password: ['password', 'initial password'],
  admin: ['admin', 'is admin', 'role'],
};
const YES = /^(yes|y|true|1|admin|administrator)$/i;

/** A password that's easy to read out and type: three groups of four letters and digits. */
export function readablePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  return [0, 4, 8].map((i) => [...b.subarray(i, i + 4)].map((x) => abc[x % abc.length]).join('')).join('-');
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
  if (at.email < 0 || (at.name < 0 && at.first < 0)) throw Object.assign(new Error('The first row must name the columns: Name (or First name and Last name) and Email'), { status: 400 });
  if (rows.length - 1 > MAX_IMPORT_USERS) throw Object.assign(new Error(`At most ${MAX_IMPORT_USERS} people at a time`), { status: 400 });
  const seen = new Set();
  return rows.slice(1).map((r, i) => {
    const get = (k) => (at[k] >= 0 ? String(r[at[k]] ?? '').trim() : '');
    const name = get('name') || [get('first'), get('last')].filter(Boolean).join(' ');
    let email = get('email').toLowerCase();
    if (email && !email.includes('@') && domain) email = `${email}@${domain}`;
    const out = { line: i + 2, name, email, password: get('password') || null, admin: YES.test(get('admin')) };
    try {
      if (!name) throw new Error('No name');
      if (name.length > 100) throw new Error('The name is too long');
      if (!email) throw new Error('No email address');
      const [local, d] = email.split('@');
      out.email = validAddress(local, d, orgId);
      if (seen.has(out.email)) throw new Error(`${out.email} is in the file twice`);
      if (out.password !== null && (out.password.length < 8 || out.password.length > 200)) throw new Error('The password must be at least 8 characters');
    } catch (e) { out.error = e.message; }
    seen.add(out.email);
    return out;
  });
}
