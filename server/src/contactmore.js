// More than one email address or phone number on a contact: the first of each is the contact's own
// (email, phone); the rest are kept as more_emails / more_phones, JSON [{ type, value }], up to ten each,
// labelled work, home, mobile (phones) or other. On a vCard they're EMAIL and TEL lines with a TYPE.
import { q } from './db.js';
import { contentLines } from './ics.js';

export const EMAIL_TYPES = ['work', 'home', 'other'];
export const PHONE_TYPES = ['mobile', 'work', 'home', 'other'];
export const MAX_MORE = 10;
const EMAIL_RE = /^[^\s@<>"(),;:\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+\d][\d ()./-]{2,29}$/;

/** A list as kept: valid entries only, no repeats (nor the main one), at most ten. Throws on a bad one when strict. */
export function cleanMore(list, kind, { main = null, strict = false } = {}) {
  if (list === null || list === undefined || list === '') return [];
  const arr = typeof list === 'string' ? (() => { try { return JSON.parse(list); } catch { return []; } })() : list;
  if (!Array.isArray(arr)) { if (strict) throw new Error(`more_${kind} must be a list`); return []; }
  const types = kind === 'emails' ? EMAIL_TYPES : PHONE_TYPES;
  const seen = new Set(main ? [String(main).trim().toLowerCase()] : []);
  const out = [];
  for (const x of arr) {
    let value = String(x?.value ?? '').trim();
    if (!value) continue;
    if (kind === 'emails') value = value.replace(/^mailto:/i, '').toLowerCase();
    else value = value.replace(/^tel:/i, '');
    const ok = kind === 'emails' ? EMAIL_RE.test(value) : PHONE_RE.test(value);
    if (!ok) { if (strict) throw new Error(kind === 'emails' ? `Not an email address: ${value}` : `Not a phone number: ${value}`); continue; }
    const key = value.toLowerCase().replace(/[\s().-]/g, '');
    if (seen.has(key) || seen.has(value.toLowerCase())) continue;
    seen.add(key);
    out.push({ type: types.includes(x?.type) ? x.type : 'other', value: value.slice(0, kind === 'emails' ? 200 : 50) });
    if (out.length >= MAX_MORE) break;
  }
  return out;
}

/** A card line's type (from its parameters, e.g. "TEL;TYPE=WORK;TYPE=VOICE") as our label. */
export function typeOf(head, kind) {
  const t = String(head || '').toLowerCase();
  if (kind === 'phones' && /cell|mobile|iphone/.test(t)) return 'mobile';
  if (/work/.test(t)) return 'work';
  if (/home/.test(t)) return 'home';
  return 'other';
}

/** EMAIL and TEL lines (raw, as on a card) as lists, and the other lines left as they were. */
export function moreFromLines(rawLines) {
  const emails = [], phones = [], rest = [];
  for (const raw of rawLines) {
    const l = contentLines(`${raw}\r\n`)[0];
    const name = l?.name?.replace(/^[\w-]+\./, '');
    const head = String(raw).split(':')[0];
    if (name === 'EMAIL') emails.push({ type: typeOf(head, 'emails'), value: l.value });
    else if (name === 'TEL') phones.push({ type: typeOf(head, 'phones'), value: l.value });
    else rest.push(raw);
  }
  return { emails, phones, rest };
}

/** The lists as card lines. */
export function moreToLines(emails, phones) {
  const T = { work: 'WORK', home: 'HOME', mobile: 'CELL', other: 'OTHER' };
  return [
    ...cleanMore(emails, 'emails').map((e) => `EMAIL;TYPE=INTERNET,${T[e.type]}:${e.value}`),
    ...cleanMore(phones, 'phones').map((p) => `TEL;TYPE=${T[p.type]}${p.type === 'mobile' ? '' : ',VOICE'}:${p.value}`),
  ];
}

/** A contact row for the browser: the lists as arrays. */
export const withMore = (c) => (c ? { ...c, more_emails: cleanMore(c.more_emails, 'emails'), more_phones: cleanMore(c.more_phones, 'phones') } : c);

/**
 * Cards synced from phones before this kept their other addresses and numbers inside the raw card:
 * bring them out into the lists (once; nothing is lost).
 */
export function liftCardMore() {
  const rows = q(`SELECT id, email, phone, vcard_extra FROM contacts WHERE (vcard_extra LIKE '%EMAIL%' OR vcard_extra LIKE '%TEL%') AND more_emails IS NULL AND more_phones IS NULL`).all();
  for (const r of rows) {
    const { emails, phones, rest } = moreFromLines(String(r.vcard_extra).split('\n'));
    if (!emails.length && !phones.length) continue;
    q('UPDATE contacts SET more_emails = ?, more_phones = ?, vcard_extra = ? WHERE id = ?')
      .run(JSON.stringify(cleanMore(emails, 'emails', { main: r.email })), JSON.stringify(cleanMore(phones, 'phones', { main: r.phone })), rest.join('\n') || null, r.id);
  }
  return rows.length;
}
