// Unsubscribing from mailing lists (RFC 2369 List-Unsubscribe, RFC 8058 one-click). A message can
// offer a mailto: address, a web link, or both; with "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
// the web link can be used directly by the server with a POST. Since the link comes from an email,
// the server only ever posts to https addresses on the public internet (never the NAS's own network),
// checked on the address it actually connects to, and it doesn't follow redirects.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/** What a message offers, from its header lines: { oneClick, url, mailto: { to, subject, body } } or null. */
export function unsubscribeOptions(headerLines = []) {
  const value = (name) => headerLines.filter((h) => h.key === name).map((h) => h.line.slice(h.line.indexOf(':') + 1)).join(',').replace(/\r?\n[ \t]+/g, ' ');
  const links = [...value('list-unsubscribe').matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const url = links.find((l) => /^https:\/\//i.test(l)) || null;
  const httpOnly = links.find((l) => /^http:\/\//i.test(l)) || null;
  const mail = links.find((l) => /^mailto:/i.test(l));
  let mailto = null;
  if (mail) {
    const [addr, query = ''] = mail.slice(7).split('?');
    const params = new URLSearchParams(query);
    const to = decodeURIComponent(addr || '').trim();
    if (/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) mailto = { to, subject: (params.get('subject') || 'unsubscribe').slice(0, 200), body: (params.get('body') || 'unsubscribe').slice(0, 1000) };
  }
  const oneClick = !!url && /List-Unsubscribe\s*=\s*One-Click/i.test(value('list-unsubscribe-post'));
  if (!url && !httpOnly && !mailto) return null;
  return { oneClick, url: url || httpOnly, mailto };
}

/** Is this IP address one the server mustn't be pointed at (its own machine or network, or not routable)? */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** A DNS lookup that refuses private addresses (used for the connection itself, so a name can't change in between). */
export function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateAddress(address)) return callback(Object.assign(new Error('That address is on a private network'), { code: 'EPRIVATE' }));
    callback(null, address, family);
  });
}

/**
 * Unsubscribe with one click: POST "List-Unsubscribe=One-Click" to the https link. Resolves with the
 * HTTP status; anything 2xx (or a redirect, which isn't followed) counts as done. `options` is for tests.
 */
export function oneClickUnsubscribe(url, { allowPrivate = false, tls = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Not a web address')); }
    if (u.protocol !== 'https:') return reject(new Error('Only secure (https) links are used'));
    if (!allowPrivate && net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('That address is on a private network'));
    const body = 'List-Unsubscribe=One-Click';
    const req = https.request(u, {
      method: 'POST', ...tls, lookup: allowPrivate ? undefined : publicLookup, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Workspace-Mail' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('The list didn’t answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}
