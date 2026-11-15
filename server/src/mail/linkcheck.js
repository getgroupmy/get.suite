// Links whose text shows one web address but which lead somewhere else: <a href="https://evil.example/login">
// www.mybank.com</a>, a favourite of phishing. Each such link is marked (data-nw-real="the real site"), so
// the reader is asked before it opens, and the message can say so above it. Links whose text is words
// ("Click here") aren't judged, nor a link to a page on the same site as its text (www. or not).
const TWO_PART = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'go', 'ltd', 'plc', 'nic', 'gob', 'mil']);

/** The part of a host name its owner registered: mail.google.com → google.com, shop.example.co.uk → example.co.uk. */
export function siteOf(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts.length;
  const take = parts[n - 1].length === 2 && TWO_PART.has(parts[n - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : all; }
  return ENTITIES[e.toLowerCase()] ?? all;
});
// A web address as people write one: with or without http(s)://, a name with a dot and a real-looking ending.
const SHOWN = /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,24})(?::\d+)?(?:[/?#]\S*)?$/iu;

/** The site a link's text claims to go to, or null when the text isn't a web address. */
export function shownSite(text) {
  const t = decode(String(text || '').replace(/<[^>]*>/g, '')).replace(/[\s​]+/g, ' ').trim().replace(/[.,;:!)]+$/, '');
  if (!t || /\s/.test(t) || t.includes('@')) return null;
  const m = SHOWN.exec(t);
  if (!m) return null;
  try { return new URL(`http://${m[1]}`).hostname; } catch { return null; } // as the browser would write it (xn-- for other alphabets)
}

/**
 * Mark the links that lead somewhere other than their text says. → { html, links: [{ shown, real }] }
 * (`links`: each pair once, up to 5.)
 */
export function checkLinks(html, { likeOf = null } = {}) {
  const links = [];
  const seen = new Set();
  const likeSeen = new Map(); // host → what it imitates (or null), worked out once per host
  const out = String(html || '').replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (all, attrs, inner) => {
    const h = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(` ${attrs}`);
    if (!h) return all;
    let real;
    try { const u = new URL(decode(h[1] ?? h[2] ?? h[3]).trim()); if (!/^https?:$/.test(u.protocol)) return all; real = u.hostname; } catch { return all; }
    const shown = shownSite(inner);
    if (shown && siteOf(real) !== siteOf(shown)) {
      const key = `${shown}\n${real}`;
      if (!seen.has(key) && links.length < 5) { seen.add(key); links.push({ shown, real }); }
      return `<a data-nw-real="${real.replace(/[^\w.-]/g, '')}" data-nw-shown="${shown.replace(/[^\w.-]/g, '')}"${attrs}>${inner}</a>`;
    }
    // A link to a site made to look like one you know (acme-login.com for acme.com): asked about too.
    if (likeOf) {
      if (!likeSeen.has(real)) likeSeen.set(real, likeOf(real));
      const like = likeSeen.get(real);
      if (like) {
        const key = `like\n${siteOf(real)}`;
        if (!seen.has(key) && links.length < 5) { seen.add(key); links.push({ real, like: like.domain }); }
        return `<a data-nw-real="${real.replace(/[^\w.-]/g, '')}" data-nw-like="${String(like.domain).replace(/[^\w.-]/g, '')}"${attrs}>${inner}</a>`;
      }
    }
    return all;
  });
  return { html: out, links };
}
