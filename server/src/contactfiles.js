// Contact files people bring from elsewhere: vCard (.vcf, one or many cards, from phones, Outlook,
// Gmail, iCloud) and CSV (Gmail's and Outlook's exports, or a simple name/email sheet).
import { birthdayOf } from './birthday.js';
import { parseVcard, buildVcard } from './vcard.js';

export const MAX_IMPORT = 5000;

/** CSV text → rows of fields (quoted fields may hold commas, quotes and new lines). Semicolons work as separators too. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

// Column names in the exports people have, lower case: the first one found is used.
const COLUMNS = {
  name: ['name', 'full name', 'display name', 'contact name'],
  first: ['given name', 'first name', 'firstname'],
  middle: ['additional name', 'middle name'],
  last: ['family name', 'last name', 'surname', 'lastname'],
  email: ['e-mail 1 - value', 'e-mail address', 'email address', 'email', 'e-mail', 'primary email', 'email 1'],
  phone: ['phone 1 - value', 'mobile phone', 'mobile', 'phone', 'primary phone', 'business phone', 'home phone', 'telephone', 'phone number'],
  company: ['organization 1 - name', 'organization name', 'company', 'organization', 'organisation'],
  notes: ['notes', 'note', 'comments'],
  birthday: ['birthday', 'birth date', 'date of birth', 'birthdate'],
};

/** Contacts from a CSV export. The first row must name the columns. */
export function contactsFromCsv(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const names = head.map((h) => h.trim().toLowerCase());
  const col = (k) => { for (const n of COLUMNS[k]) { const i = names.indexOf(n); if (i >= 0) return i; } return -1; };
  const at = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
  if (at.name < 0 && at.first < 0 && at.last < 0 && at.email < 0) return null; // not a contacts file
  const v = (r, k) => (at[k] >= 0 ? String(r[at[k]] ?? '').trim() : '');
  return rows.map((r) => {
    const email = v(r, 'email').split(/\s*:::\s*|[;,]\s*/)[0] || ''; // Gmail joins several with " ::: "
    const name = v(r, 'name') || [v(r, 'first'), v(r, 'middle'), v(r, 'last')].filter(Boolean).join(' ') || email;
    return { name, email: /@/.test(email) ? email.toLowerCase() : null, phone: v(r, 'phone').split(/\s*:::\s*/)[0] || null, company: v(r, 'company') || null, notes: v(r, 'notes') || null, birthday: birthdayOf(v(r, 'birthday')) };
  }).filter((c) => c.name);
}

/** Contacts from a .vcf file holding one or more cards. */
export function contactsFromVcards(text) {
  const cards = String(text || '').replace(/\r?\n[ \t]/g, (m) => m).match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];
  return cards.map((card) => parseVcard(card)).filter((c) => !c.error);
}

/** What a file holds: vCards or CSV. Returns { contacts } or { error }. */
export function contactsFromFile(text) {
  const t = String(text || '');
  if (/BEGIN:VCARD/i.test(t)) return { contacts: contactsFromVcards(t) };
  const csv = contactsFromCsv(t);
  if (csv === null) return { error: 'This doesn’t look like a contacts file. Use a vCard (.vcf) or a CSV with a Name or Email column.' };
  return { contacts: csv };
}

const csvField = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Contacts as a CSV that Gmail, Outlook and spreadsheets read. */
export function contactsToCsv(list) {
  const rows = [['Name', 'E-mail Address', 'Phone', 'Company', 'Notes', 'Birthday'], ...list.map((c) => [c.name, c.email, c.phone, c.company, c.notes, c.birthday])];
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}
export const contactsToVcf = (list) => list.map((c) => buildVcard(c)).join('');
