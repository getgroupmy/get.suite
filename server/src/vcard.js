// Contact cards (vCard 3.0, which every phone reads) for CardDAV. Workspace keeps name, email,
// phone, company and notes; anything else on a card from a phone (addresses, birthdays, more
// numbers, a photo) is kept as it came, so syncing never drops it.
import { contentLines, unescapeText, escapeText, fold } from './ics.js';

const KNOWN = new Set(['BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N', 'ORG', 'NOTE', 'PRODID', 'REV']);
const MAX_EXTRA = 256 * 1024; // photos can be big; keep cards reasonable

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
  const extra = String(c.vcard_extra || '').split(/\r?\n/).filter(Boolean);
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
  const unfolded = raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  // Keep every line Workspace doesn't model (raw, as it came), except the email/number it shows.
  const extra = [];
  let size = 0;
  for (const [i, line] of unfolded.entries()) {
    const l = lines[i];
    if (!l || KNOWN.has(l.name) || l === email || l === tel) continue;
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
    vcard_extra: extra.join('\n') || null,
  };
}
