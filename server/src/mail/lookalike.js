// Look-alike sender domains: acrne.com or acme-corp.com posing as the company's acme.com, paypa1.com
// or rnicrosoft.com posing as someone you deal with, or a domain in another alphabet (Cyrillic а for a)
// made to read like a familiar one. Used for the warning above an email (external.js).
import { domainToUnicode } from 'node:url';

const ch = (n) => String.fromCharCode(n);
/** Letters from other alphabets that look like Latin ones (Cyrillic and Greek), and digits used for letters. */
const CONFUSABLE = new Map([
  [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0445, 'x'], [0x0443, 'y'], [0x0456, 'i'], [0x0458, 'j'], [0x0455, 's'],
  [0x04bb, 'h'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'], [0x03bf, 'o'], [0x03b1, 'a'], [0x03b5, 'e'], [0x03b9, 'i'], [0x03ba, 'k'], [0x03bd, 'v'],
  [0x03c1, 'p'], [0x03c4, 't'], [0x03c5, 'u'], [0x0131, 'i'],
].map(([c, l]) => [ch(c), l]));

/** How a domain reads at a glance: other alphabets' look-alikes, 0/1/3/5 for o/l/e/s, rn for m, vv for w, I for l; no hyphens. */
export function skeleton(domain) {
  let d = domainToUnicode(String(domain || '').toLowerCase()) || String(domain || '').toLowerCase();
  d = d.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  d = [...d].map((c) => CONFUSABLE.get(c) || c).join('');
  return d.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i|]/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/-/g, '');
}

/** Edits (insert, delete, change, swap two neighbours) between two words, stopping above max. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** "acme.co.uk" → { name: 'acme', rest: 'co.uk' } (the label before the ending; good enough for comparing). */
function split(domain) {
  const labels = domain.split('.');
  const two = labels.length >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 2]);
  const cut = labels.length - (two ? 2 : 1);
  return { name: labels[cut - 1] || '', rest: labels.slice(cut).join('.') };
}
const EXTRA = /^(corp|inc|ltd|llc|group|global|intl|hq|team|support|help|helpdesk|secure|security|login|signin|account|accounts|verify|mail|email|billing|invoice|invoices|pay|payment|payments|hr|it|admin|service|services|online|portal|update|notice|alert|alerts|official|co)$/;

/**
 * The known domain this one imitates, or null: `domain` is the sender's, `known` the domains to protect
 * ([{ domain, kind: 'company' | 'known' }]). The same domain, or a subdomain of a known one, isn't a look-alike.
 */
export function lookalikeOf(domain, known) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!d.includes('.')) return null;
  const sd = skeleton(d), ds = split(d), dsk = split(sd);
  for (const k of known) {
    const kd = String(k.domain || '').toLowerCase();
    if (!kd || d === kd || d.endsWith(`.${kd}`) || kd.endsWith(`.${d}`)) continue;
    const ks = split(kd), ksk = split(skeleton(kd));
    if (ks.name.length < 3) continue;
    // Reads the same (paypa1.com, rnicrosoft.com, аcme.com in Cyrillic).
    if (sd === skeleton(kd)) return k;
    // One letter off, swapped or doubled (acmee.com, amce.com), for names long enough not to collide by chance.
    if (dsk.rest === ksk.rest && ks.name.length >= 5 && editDistance(dsk.name, ksk.name, 1) <= 1) return k;
    // The same name at another ending (acme.co for acme.com) or with a word added (acme-corp.com, acmesupport.com): only for the company's own.
    if (k.kind === 'company') {
      if (ds.name === ks.name && ds.rest !== ks.rest) return k;
      const words = ds.name.split('-');
      if (words.length > 1 && words.includes(ks.name) && words.every((w) => w === ks.name || EXTRA.test(w))) return k;
      if (ds.name.startsWith(ks.name) && EXTRA.test(ds.name.slice(ks.name.length)) && ds.name !== ks.name) return k;
    }
  }
  return null;
}
