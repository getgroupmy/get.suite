// Whether an email really comes from the domain in its From, as this server's spam filter found when it
// arrived (the topmost Authentication-Results header, which Rspamd adds; ones further down were written by
// other servers, or by the sender, and aren't trusted). Gmail shows a "?" for the same thing.
//   'forged'     DMARC failed: the domain's owner says mail like this isn't theirs.
//   'unverified' no check vouches for the From domain (no SPF or DKIM pass for it, and no DMARC pass).
//   null         it's verified, or there's nothing to go on (no results, or mail from the company itself).
import { siteOf } from './linkcheck.js';

const pairs = (value) => {
  const out = [];
  // "spf=pass smtp.mailfrom=x.com; dkim=pass header.d=x.com header.s=s1; dmarc=pass header.from=x.com"
  for (const part of String(value).split(';').slice(1)) {
    const m = /\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const props = {};
    for (const p of part.matchAll(/\b([a-z]+\.[a-z-]+)\s*=\s*"?([^\s;"]+)"?/gi)) props[p[1].toLowerCase()] = p[2].toLowerCase();
    out.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props });
  }
  return out;
};
const domainOf = (v) => String(v || '').split('@').pop().replace(/[>\s]/g, '');

/** headerLines: mailparser's [{ key, line }], top first. → 'forged' | 'unverified' | null */
export function senderVerdict(headerLines, fromAddress, ownDomains = []) {
  const from = String(fromAddress || '').toLowerCase().split('@')[1];
  if (!from || ownDomains.includes(from)) return null;
  const ar = (headerLines || []).find((h) => h.key === 'authentication-results');
  if (!ar) return null;
  const results = pairs(ar.line.replace(/^[^:]*:\s*/, '').replace(/\r?\n[ \t]+/g, ' '));
  if (!results.length) return null;
  const site = siteOf(from);
  if (results.some((r) => r.method === 'dmarc' && r.result === 'fail')) return 'forged';
  if (results.some((r) => r.method === 'dmarc' && r.result === 'pass')) return null;
  const vouched = results.some((r) => r.result === 'pass' && (
    (r.method === 'dkim' && siteOf(domainOf(r.props['header.d'] || r.props['header.i'])) === site)
    || (r.method === 'spf' && siteOf(domainOf(r.props['smtp.mailfrom'])) === site)));
  return vouched ? null : 'unverified';
}
