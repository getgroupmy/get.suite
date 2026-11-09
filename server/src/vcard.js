// Contact cards (vCard 3.0, which every phone reads) for CardDAV. Workspace keeps name, email,
// phone, company, job title, an address, a web page, notes and birthday; anything else on a card from a phone (more
// numbers, a photo) is kept as it came, so syncing never drops it.
import { birthdayOf } from './birthday.js';
import { contentLines, unescapeText, escapeText, fold } from './ics.js';
import { cleanMore, moreToLines, typeOf } from './contactmore.js';

const KNOWN = new Set(['BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N', 'ORG', 'NOTE', 'PRODID', 'REV', 'BDAY', 'TITLE', 'URL']);
const PHOTO_TYPES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WEBP', 'image/gif': 'GIF' };
const isPhotoLine = (l) => /^([\w-]+\.)?PHOTO[;:]/i.test(l);
const MAX_EXTRA = 256 * 1024; // photos can be big; keep cards reasonable

/** ADR is "post box;extended;street;city;region;postcode;country": shown as lines, empty parts left out. */
const adrText = (value) => String(value).split(/(?<!\\);/).map((x) => unescapeText(x).trim()).filter(Boolean).join('\n');

/** The card for a contact. */
export function buildVcard(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//NAS Workspace//Contacts//EN', `UID:${c.vcard_uid || c.id}`];
  const name = c.name || c.email || 'Unnamed';
  lines.push(`FN:${escapeText(name)}`);
  // N is "family;given;middle;prefix;suffix": a rough split is better than none.
  const parts = name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts.pop() : '';
  lines.push(`N:${escapeText(family)};${escapeText(parts.join(' '))};;;`);
  if (c.company) lines.push(`ORG:${escapeText(c.company)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${c.email}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${c.phone}`);
  if (c.notes) lines.push(`NOTE:${escapeText(c.notes)}`);
  if (c.title) lines.push(`TITLE:${escapeText(c.title)}`);

  if (c.website) lines.push(`URL:${c.website}`);
  if (c.birthday) lines.push(`BDAY${c.birthday.startsWith('--') ? ';X-APPLE-OMIT-YEAR=1604' : ''}:${c.birthday.startsWith('--') ? `1604${c.birthday.slice(1)}` : c.birthday}`); // phones read a year; Apple's 1604 means none
  // Other addresses and numbers, from the lists (lines a card came with for them aren't kept twice).
  lines.push(...moreToLines(c.more_emails, c.more_phones));
  let extra = String(c.vcard_extra || '').split(/\r?\n/).filter(Boolean).filter((l) => !/^([\w-]+\.)?(EMAIL|TEL)[;:]/i.test(l));
  // The photo kept in Workspace (when there is one) replaces any the card came with.
  if (c.photo?.length) { extra = extra.filter((l) => !isPhotoLine(l)); lines.push(`PHOTO;ENCODING=b;TYPE=${PHOTO_TYPES[c.photo_type] || 'JPEG'}:${Buffer.from(c.photo).toString('base64')}`); }
  // The address: the phone's own line when it still says the same, else one written from the text.
  const adrAt = extra.findIndex((l) => /^([\w-]+\.)?ADR[;:]/i.test(l) && /pref/i.test(l.split(':')[0]));
  const first = adrAt >= 0 ? adrAt : extra.findIndex((l) => /^([\w-]+\.)?ADR[;:]/i.test(l));
  const kept = first >= 0 ? adrText(extra[first].slice(extra[first].indexOf(':') + 1)) : '';
  if ((c.address || '') !== kept) {
    if (first >= 0) extra = extra.filter((_, i) => i !== first);
    if (c.address) lines.push(`ADR;TYPE=WORK:;;${escapeText(c.address)};;;;`); // the whole address in the street part
  }
  return fold([...lines, ...extra, 'END:VCARD']);
}

/** A card from a phone: the fields Workspace shows, plus the rest kept as it came. */
export function parseVcard(text) {
  const raw = String(text || '');
  if (!/BEGIN:VCARD/i.test(raw)) return { error: 'Not a contact card' };
  const lines = contentLines(raw);
  const get = (n) => lines.find((l) => l.name === n || l.name.endsWith(`.${n}`));
  let name = unescapeText(get('FN')?.value || '').trim();
  if (!name) {
    const n = (get('N')?.value || '').split(';').map(unescapeText);
    name = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(' ').trim();
  }
  const emails = lines.filter((l) => l.name === 'EMAIL' || l.name.endsWith('.EMAIL'));
  const tels = lines.filter((l) => l.name === 'TEL' || l.name.endsWith('.TEL'));
  // The preferred email/number (TYPE=PREF or PREF=1) is the one shown; others stay on the card.
  const pref = (list) => list.find((l) => /pref/i.test(l.params.TYPE || '') || l.params.PREF) || list[0];
  const email = pref(emails), tel = pref(tels);
  const adrs = lines.filter((l) => l.name === 'ADR' || l.name.endsWith('.ADR'));
  const adr = pref(adrs);
  // ADR is "post box;extended;street;city;region;postcode;country": shown as lines, empty parts left out.
  const address = adr ? adrText(adr.value) : '';
  const unfolded = raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  // A photo sent inside the card (base64, or a data: address) becomes the contact's photo.
  let photo = null;
  const ph = lines.find((l) => l.name === 'PHOTO' || l.name.endsWith('.PHOTO'));
  if (ph) {
    const v = ph.value.trim();
    const m = /^data:image\/[\w.+-]+;base64,(.*)$/is.exec(v);
    const b64 = m ? m[1] : /^(b|base64)$/i.test(ph.params.ENCODING || '') ? v : null;
    if (b64) { const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64'); if (buf.length) photo = buf; }
  }
  // Each line's name and parameters as written ("TEL;TYPE=WORK;TYPE=VOICE"), to read its type from.
  const headOf = new Map(lines.map((l, i) => [l, String(unfolded[i] || '').split(':')[0]]));
  // Keep every line Workspace doesn't model (raw, as it came), except the email/number it shows.
  const extra = [];
  let size = 0;
  for (const [i, line] of unfolded.entries()) {
    const l = lines[i];
    if (!l || KNOWN.has(l.name) || emails.includes(l) || tels.includes(l) || (photo && l === ph)) continue; // emails and numbers: in the lists; the address line stays as it came
    if ((size += line.length) > MAX_EXTRA) break;
    extra.push(line);
  }
  return {
    uid: get('UID')?.value.trim() || null,
    name: (name || unescapeText(email?.value || '') || 'Unnamed').slice(0, 200),
    email: email ? email.value.trim().replace(/^mailto:/i, '').slice(0, 200) : null,
    phone: tel ? tel.value.trim().replace(/^tel:/i, '').slice(0, 50) : null,
    company: unescapeText((get('ORG')?.value || '').split(';')[0]).slice(0, 200) || null,
    notes: unescapeText(get('NOTE')?.value || '').slice(0, 5000) || null,
    title: unescapeText(get('TITLE')?.value || '').slice(0, 200) || null,
    address: address.slice(0, 500) || null,
    website: (get('URL')?.value || '').trim().slice(0, 300) || null,
    birthday: birthdayOf(get('BDAY')?.value),
    vcard_extra: extra.join('\n') || null,
    // The other addresses and numbers (the shown ones are email and phone).
    more_emails: cleanMore(emails.filter((l) => l !== email).map((l) => ({ type: typeOf(headOf.get(l), 'emails'), value: l.value })), 'emails', { main: email?.value }),
    more_phones: cleanMore(tels.filter((l) => l !== tel).map((l) => ({ type: typeOf(headOf.get(l), 'phones'), value: l.value })), 'phones', { main: tel?.value }),
    ...(photo && { photo }),
  };
}
