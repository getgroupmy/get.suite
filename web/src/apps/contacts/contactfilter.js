import { fold } from '../../fold.js';

const digits = (t) => String(t).replace(/\D/g, '');

/**
 * Whether a contact fits what was typed in the Filter box: every word has to be somewhere in the
 * contact — not necessarily in the same field, so "martin acme" finds Bob Martin at Acme — and
 * a number is found however the phone number is written ("5550142" finds "+1 (555) 01-42").
 */
export function matchesFilter(contact, filter) {
  const words = fold(filter).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const texts = Object.values(contact).filter((v) => typeof v === 'string' && v).map(fold);
  const more = typeof contact.more_phones === 'string' ? contact.more_phones : JSON.stringify(contact.more_phones || '');
  const phones = [contact.phone || '', ...more.split('"')].map(digits).filter(Boolean); // each number on its own
  const rings = (n) => phones.some((p) => p.includes(n));
  if (texts.some((t) => t.includes(words.join(' ')))) return true;
  const whole = digits(filter); // "555 0142" typed with a space is still one number
  if (whole.length >= 3 && /^[\d\s()+.-]+$/.test(filter.trim()) && rings(whole)) return true;
  return words.every((w) => texts.some((t) => t.includes(w)) || (/^\+?[\d().-]{3,}$/.test(w) && digits(w).length >= 3 && rings(digits(w))));
}
