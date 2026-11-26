import { fold } from '../../fold.js';

const digits = (t) => String(t).replace(/\D/g, '');

/**
 * Whether a contact fits what was typed in the Filter box: every word has to be somewhere in the
 * contact — not necessarily in the same field, so "martin acme" finds Bob Martin at Acme — and
 * a number is found however the phone number is written ("5550142" finds "+1 (555) 01-42"). Other email
 * addresses and fields of your own count too.
 */
export function matchesFilter(contact, filter) {
  const words = fold(filter).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  // Its text fields, its other email addresses, and its fields of your own (label and value); not who it's
  // related to (a related person's name, clicked, finds that person).
  const list = (v) => (Array.isArray(v) ? v : (() => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })());
  const LISTS = new Set(['more_emails', 'more_phones', 'dates', 'custom_fields', 'related']); // (searched below, item by item)
  // Not what's kept for the app's own use: ids (random letters and digits, so "44" found one contact in six), the phone
  // sync's names for it, the rest of an imported card, a picture.
  const HIDDEN = new Set(['id', 'dav_name', 'vcard_uid', 'vcard_extra', 'photo']);
  const hidden = (k) => HIDDEN.has(k) || k.endsWith('_id');
  const texts = [...Object.entries(contact).filter(([k, v]) => typeof v === 'string' && v && !LISTS.has(k) && !hidden(k)).map(([, v]) => v),
    ...list(contact.more_emails).map((x) => x?.value), ...list(contact.custom_fields).flatMap((x) => [x?.label, x?.value])].filter(Boolean).map((t) => fold(String(t)));
  const more = typeof contact.more_phones === 'string' ? contact.more_phones : JSON.stringify(contact.more_phones || '');
  const phones = [contact.phone || '', ...more.split('"')].map(digits).filter(Boolean); // each number on its own
  const rings = (n) => phones.some((p) => p.includes(n));
  if (texts.some((t) => t.includes(words.join(' ')))) return true;
  const whole = digits(filter); // "555 0142" typed with a space is still one number
  if (whole.length >= 3 && /^[\d\s()+.-]+$/.test(filter.trim()) && rings(whole)) return true;
  return words.every((w) => texts.some((t) => t.includes(w)) || (/^\+?[\d().-]{3,}$/.test(w) && digits(w).length >= 3 && rings(digits(w))));
}
