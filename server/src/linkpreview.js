// Link previews in Chat: the first web link in a message gets its page's title, description and site
// name under it. Only public addresses are fetched (each redirect checked too), only HTML, the first
// 512 KB of it, and no pictures, so nobody's browser loads anything from the linked site. Previews
// are kept for a day.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { q } from './db.js';
import { isPrivateAddress, publicLookup } from './mail/unsubscribe.js';

q(`CREATE TABLE IF NOT EXISTS link_previews (
  url TEXT PRIMARY KEY,
  data TEXT,                         -- JSON { url, title, description, site } or null (nothing to show)
  fetched_at INTEGER NOT NULL
)`).run();

const MAX_BYTES = 512 * 1024, KEEP_MS = 864e5;
const allowPrivate = () => process.env.LINK_PREVIEWS_ALLOW_PRIVATE === '1';

/** The first http(s) link in a message's text (not one into this Workspace), or null. */
export function firstLink(text, ownHost = null) {
  for (const m of String(text || '').matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    const raw = m[0].replace(/[).,;:!?\]]+$/, '');
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.username || u.password) continue;
    if (ownHost && u.host.toLowerCase() === ownHost.toLowerCase()) continue; // shown as a file card instead
    return u.toString();
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const clean = (s, max) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max) || null;

/** What a page says about itself: { title, description, site } (null when it says nothing). */
export function readPreview(html, url) {
  const head = String(html).slice(0, MAX_BYTES).split(/<\/head>/i)[0];
  const metas = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in metas)) metas[key] = content[1] ?? content[2];
  }
  const title = clean(metas['og:title'] || metas['twitter:title'] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1], 200);
  if (!title) return null;
  return {
    url, title,
    description: clean(metas['og:description'] || metas.description || metas['twitter:description'], 300),
    site: clean(metas['og:site_name'], 80) || new URL(url).hostname.replace(/^www\./, ''),
  };
}

/** Fetch a page's HTML (redirects followed and checked), or throw. */
function fetchPage(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && net.isIP(host) && isPrivateAddress(host)) return reject(new Error('private'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { lookup: allowPrivate() ? undefined : publicLookup, timeout: 8000, headers: { 'User-Agent': 'Workspace-LinkPreview', Accept: 'text/html,application/xhtml+xml' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('redirects'));
        let next;
        try { next = new URL(res.headers.location, u); } catch (e) { return reject(e); }
        if (!['http:', 'https:'].includes(next.protocol)) return reject(new Error('protocol'));
        return fetchPage(next.toString(), hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(res.headers['content-type'] || '')) { res.resume(); return reject(new Error('not a page')); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; chunks.push(c); if (size > MAX_BYTES) { res.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); } });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** The preview for a link (kept for a day; null when there's nothing to show). */
export async function previewFor(url, t = Date.now()) {
  const kept = q('SELECT data, fetched_at FROM link_previews WHERE url = ?').get(url);
  if (kept && t - kept.fetched_at < KEEP_MS) return kept.data ? JSON.parse(kept.data) : null;
  let data = null;
  try { data = readPreview(await fetchPage(url), url); } catch { data = null; }
  q('INSERT INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').run(url, data ? JSON.stringify(data) : null, t);
  return data;
}
