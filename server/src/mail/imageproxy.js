// Pictures in emails, loaded through Workspace: the message is shown with its pictures' addresses
// rewritten to /api/mail/image?u=…&s=… (signed, so this isn't an open proxy), and the server fetches
// them, so the sender never learns the reader's address, browser or location. Only public addresses
// (nothing on the local network, checked again after DNS so a name can't point inside), only pictures,
// up to 10 MB, 10 seconds and 3 redirects; kept briefly in memory; a limit per person.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { isPrivateAddress } from './unsubscribe.js';

const SECRET = crypto.randomBytes(32); // links are re-signed each time a message is opened
const MAX_BYTES = 10 * 1024 * 1024, TIMEOUT = 10e3, MAX_REDIRECTS = 3;

/** The signature for a picture's address, for this person. */
export const signImage = (userId, url) => crypto.createHmac('sha256', SECRET).update(`${userId}\n${url}`).digest('base64url').slice(0, 32);
export function checkImageSig(userId, url, sig) {
  const want = Buffer.from(signImage(userId, url));
  const got = Buffer.from(String(sig || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const proxied = (userId, url) => `/api/mail/image?u=${encodeURIComponent(url)}&s=${signImage(userId, url)}`;
const remote = (u) => /^https?:\/\//i.test(u.trim());
const decode = (u) => u.replace(/&amp;/gi, '&').trim();

/**
 * The email's HTML with its pictures from the internet pointing at the proxy: <img src/srcset>,
 * background="…", poster, SVG <image href>, and CSS url(…) in style attributes and <style>. Links
 * (<a href>) are left alone. → { html, count }
 */
export function proxyImages(html, userId) {
  let count = 0;
  const one = (u) => { if (!remote(decode(u))) return u; count++; return proxied(userId, decode(u)).replace(/&/g, '&amp;'); };
  let out = String(html || '');
  // Attributes holding one picture address.
  out = out.replace(/(<(?:img|image|input|video|source|body|table|td|th|tr|div|span|p|center)\b[^>]*?\s(?:src|background|poster|href|xlink:href)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>"']+))/gi,
    (all, pre, _q, dq, sq, bare) => {
      if (/^<a\b/i.test(pre)) return all;
      const tag = /^<(\w+)/.exec(pre)[1].toLowerCase();
      const attr = /(\S+)\s*=\s*$/.exec(pre)[1].toLowerCase();
      if ((attr === 'href' || attr === 'xlink:href') && tag !== 'image') return all; // only SVG pictures' href
      const v = dq ?? sq ?? bare;
      return `${pre}"${one(v)}"`;
    });
  // srcset: several addresses, each with a size.
  out = out.replace(/(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi, (all, pre, _q, dq, sq) => {
    const v = (dq ?? sq).split(',').map((part) => { const [u, ...rest] = part.trim().split(/\s+/); return [one(u), ...rest].join(' '); }).join(', ');
    return `${pre}"${v}"`;
  });
  // CSS: url(…) anywhere (style attributes and <style> blocks).
  out = out.replace(/url\(\s*(['"]?)((?:https?:)?\/\/[^)'"]+)\1\s*\)/gi, (all, q, u) => `url("${one(u.startsWith('//') ? `https:${u}` : u)}")`);
  return { html: out, count };
}

/** Connect only to public addresses (resolved here, so the name can't switch to an inside one in between). */
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((a) => !isPrivateAddress(a.address));
    if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error('That address is on a private network'), { code: 'EPRIVATE' }));
    if (opts?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

/** Fetch a picture: { type, body } or throws { status, message }. */
export function fetchImage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(Object.assign(new Error('Not a web address'), { status: 400 })); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return reject(Object.assign(new Error('Only web addresses'), { status: 400 }));
    if (u.port && !['80', '443'].includes(u.port) && !(process.env.MAIL_IMAGE_ALLOW_PORTS || '').split(',').includes(u.port)) return reject(Object.assign(new Error('Only the usual web ports'), { status: 400 }));
    // An address written as numbers isn't looked up, so it's checked here.
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && isPrivateAddress(literal) && process.env.MAIL_IMAGE_ALLOW_PRIVATE !== '1') return reject(Object.assign(new Error('That address is on a private network'), { status: 403 }));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: process.env.MAIL_IMAGE_ALLOW_PRIVATE === '1' ? undefined : safeLookup, timeout: TIMEOUT,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Workspace image proxy)', accept: 'image/avif,image/webp,image/png,image/*;q=0.8' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(Object.assign(new Error('Too many redirects'), { status: 502 }));
        return fetchImage(new URL(res.headers.location, u).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`The picture’s server answered ${res.statusCode}`), { status: 502 })); }
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/[\w.+-]+$/.test(type)) { res.resume(); return reject(Object.assign(new Error('Not a picture'), { status: 415 })); }
      if (Number(res.headers['content-length']) > MAX_BYTES) { res.resume(); return reject(Object.assign(new Error('Picture too large'), { status: 413 })); }
      const parts = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) { req.destroy(); reject(Object.assign(new Error('Picture too large'), { status: 413 })); } else parts.push(c); });
      res.on('end', () => { if (n <= MAX_BYTES) resolve({ type, body: Buffer.concat(parts) }); });
      res.on('error', (e) => reject(Object.assign(e, { status: 502 })));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The picture took too long'), { status: 504 })));
    req.on('error', (e) => reject(Object.assign(e, { status: e.status || (e.code === 'EPRIVATE' ? 403 : 502) })));
  });
}

// A short-lived cache (the same picture in many emails, or opened twice), and a limit per person.
const cache = new Map(); // url → { type, body, at }
let cached = 0;
const CACHE_BYTES = 40 * 1024 * 1024, CACHE_MS = 30 * 60e3;
export async function imageFor(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const got = await fetchImage(url);
  const item = { ...got, at: Date.now() };
  cache.set(url, item); cached += got.body.length;
  for (const [k, v] of cache) { if (cached <= CACHE_BYTES) break; cache.delete(k); cached -= v.body.length; }
  return item;
}
const counts = new Map(); // user → { n, since }
export function overLimit(userId, max = 600, windowMs = 10 * 60e3) {
  const c = counts.get(userId);
  if (!c || Date.now() - c.since > windowMs) { counts.set(userId, { n: 1, since: Date.now() }); return false; }
  c.n++;
  return c.n > max;
}
