// Contact files people bring from elsewhere: vCard (.vcf, one or many cards, from phones, Outlook,
// Gmail, iCloud) and CSV (Gmail's and Outlook's exports, or a simple name/email sheet).
import { birthdayOf } from './birthday.js';
import { parseVcard, buildVcard } from './vcard.js';
import { cleanMore } from './contactmore.js';

export const MAX_IMPORT = 5000;

/** CSV text → rows of fields (quoted fields may hold commas, quotes and new lines). Semicolons work as separators too. */
export function parseCsv(text, { keepEmpty = false } = {}) {
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
  return keepEmpty ? rows : rows.filter((r) => r.some((f) => f.trim())); // keepEmpty: blank rows stay, so row numbers do
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
  title: ['organization 1 - title', 'job title', 'title'],
  address: ['address 1 - formatted', 'address', 'business address', 'home address', 'street'],
  website: ['website 1 - value', 'web page', 'website', 'url'],
};

/** A label word from an export ("Mobile", "* Work", "Business") as ours. */
function typeFromWord(word, kind) {
  const w = String(word).toLowerCase();
  if (kind === 'phones' && /mobile|cell/.test(w)) return 'mobile';
  if (/work|business/.test(w)) return 'work';
  if (/home|personal/.test(w)) return 'home';
  return 'other';
}

/**
 * The columns holding email addresses and phone numbers, in order: Gmail's "E-mail 2 - Value" (with its
 * "E-mail 2 - Type"), Outlook's "E-mail 2 Address", "Mobile Phone", "Business Phone", "Home Phone"…,
 * and plain ones ("Email", "Phone"). [{ kind, at, typeAt, type }]
 */
function moreColumns(names) {
  const out = [];
  names.forEach((n, i) => {
    let m;
    if ((m = /^e-mail (\d+) - value$/.exec(n))) out.push({ kind: 'emails', at: i, typeAt: names.indexOf(`e-mail ${m[1]} - type`), type: 'other', order: Number(m[1]) });
    else if ((m = /^phone (\d+) - value$/.exec(n))) out.push({ kind: 'phones', at: i, typeAt: names.indexOf(`phone ${m[1]} - type`), type: 'other', order: Number(m[1]) });
    else if ((m = /^e-?mail(?: (\d+))? address$/.exec(n)) || /^(e-?mail|primary email|email 1)$/.test(n)) out.push({ kind: 'emails', at: i, typeAt: -1, type: 'other', order: m?.[1] ? Number(m[1]) : 1 });
    else if ((m = /^(mobile|business|home|other|primary|company main|car|work)(?: phone)?(?: (\d+))?$/.exec(n)) && /phone|mobile/.test(n)) out.push({ kind: 'phones', at: i, typeAt: -1, type: typeFromWord(m[1], 'phones'), order: 1 + (m[2] ? Number(m[2]) / 10 : 0) + ['primary', 'mobile', 'business', 'work', 'home', 'company main', 'other', 'car'].indexOf(m[1]) / 100 });
    else if (/^(phone|telephone|phone number|mobile)$/.test(n)) out.push({ kind: 'phones', at: i, typeAt: -1, type: n === 'mobile' ? 'mobile' : 'other', order: 1 });
  });
  return out.sort((a, b) => a.order - b.order);
}

/** Contacts from a CSV export. The first row must name the columns. */
export function contactsFromCsv(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const names = head.map((h) => h.trim().toLowerCase());
  const col = (k) => { for (const n of COLUMNS[k]) { const i = names.indexOf(n); if (i >= 0) return i; } return -1; };
  const at = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
  if (at.name < 0 && at.first < 0 && at.last < 0 && at.email < 0) return null; // not a contacts file
  const v = (r, k) => (at[k] >= 0 ? String(r[at[k]] ?? '').trim() : '');
  const slots = moreColumns(names);
  return rows.map((r) => {
    const name0 = v(r, 'name') || [v(r, 'first'), v(r, 'middle'), v(r, 'last')].filter(Boolean).join(' ');
    // Every address and number the row has, in column order: the first of each is the contact's own.
    const all = { emails: [], phones: [] };
    for (const sl of slots) {
      const raw = String(r[sl.at] ?? '').trim();
      if (!raw) continue;
      const type = sl.typeAt >= 0 ? typeFromWord(String(r[sl.typeAt] ?? ''), sl.kind) : sl.type;
      for (const value of raw.split(sl.kind === 'emails' ? /\s*:::\s*|[;,]\s*/ : /\s*:::\s*/)) if (value) all[sl.kind].push({ type, value }); // Gmail joins several with " ::: "
    }
    const email = all.emails.find((e) => /@/.test(e.value))?.value.toLowerCase() || null;
    const phone = all.phones[0]?.value || null;
    const name = name0 || email || '';
    return { name, email, phone, company: v(r, 'company') || null, notes: v(r, 'notes') || null, birthday: birthdayOf(v(r, 'birthday')), title: v(r, 'title') || null, address: v(r, 'address') || null, website: v(r, 'website') || null,
      more_emails: cleanMore(all.emails, 'emails', { main: email }), more_phones: cleanMore(all.phones.slice(1), 'phones', { main: phone }) };
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
  // Other addresses and numbers as Gmail writes them ("E-mail 2 - Type", "E-mail 2 - Value"…), as many as the most anyone has.
  const more = list.map((c) => ({ e: cleanMore(c.more_emails, 'emails'), p: cleanMore(c.more_phones, 'phones') }));
  const ne = Math.max(0, ...more.map((m) => m.e.length)), np = Math.max(0, ...more.map((m) => m.p.length));
  const label = (t) => ({ work: 'Work', home: 'Home', mobile: 'Mobile', other: 'Other' })[t] || 'Other';
  const head = ['Name', 'E-mail Address', 'Phone', 'Company', 'Notes', 'Birthday', 'Job Title', 'Address', 'Web Page',
    ...Array.from({ length: ne }, (_, i) => [`E-mail ${i + 2} - Type`, `E-mail ${i + 2} - Value`]).flat(),
    ...Array.from({ length: np }, (_, i) => [`Phone ${i + 2} - Type`, `Phone ${i + 2} - Value`]).flat()];
  const rows = [head, ...list.map((c, k) => [c.name, c.email, c.phone, c.company, c.notes, c.birthday, c.title, c.address, c.website,
    ...Array.from({ length: ne }, (_, i) => (more[k].e[i] ? [label(more[k].e[i].type), more[k].e[i].value] : ['', ''])).flat(),
    ...Array.from({ length: np }, (_, i) => (more[k].p[i] ? [label(more[k].p[i].type), more[k].p[i].value] : ['', ''])).flat()])];
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}
export const contactsToVcf = (list) => list.map((c) => buildVcard(c)).join('');
