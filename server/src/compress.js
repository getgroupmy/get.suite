// Compression (gzip) for what the server sends most of: JSON from the API and the web app's own files.
// A big Drive folder's list is megabytes of JSON, and the app's scripts are hundreds of kilobytes; both
// shrink several times over. Built on node:zlib (no extra package).
//
// API answers are compressed only for GET requests: answers that hold a secret (a new API token, a
// mail-app password) come from POSTs, so a secret is never compressed alongside text an attacker chose
// (the BREACH attack on compressed HTTPS).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MIN = 1400; // smaller than one network packet: not worth it

/** Middleware for /api: res.json for GET requests goes out gzipped when the browser takes it and it's big enough. */
export function compressJson() {
  return (req, res, next) => {
    if (req.method !== 'GET' || !req.acceptsEncodings('gzip')) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      if (text === undefined || text.length < MIN || res.getHeader('Content-Encoding')) return json(body);
      zlib.gzip(text, { level: 4 }, (err, out) => {
        if (err || res.headersSent) return json(body);
        res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': out.length });
        res.vary('Accept-Encoding');
        res.end(out);
      });
      return res;
    };
    next();
  };
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

/**
 * Middleware before express.static: the web app's text files (scripts, styles, SVG…) gzipped, each kept
 * compressed in memory once (they change only with a new version). `headers(path)` adds the same caching
 * headers express.static would. Anything else falls through to express.static.
 */
export function gzipStatic(dir, headers = () => ({})) {
  const root = path.resolve(dir);
  const cache = new Map();
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.acceptsEncodings('gzip')) return next();
    const type = TYPES[path.extname(req.path).toLowerCase()];
    if (!type) return next();
    let file;
    try { file = path.join(root, decodeURIComponent(req.path)); } catch { return next(); }
    if (!file.startsWith(root + path.sep)) return next();
    let st;
    try { st = fs.statSync(file); } catch { return next(); }
    if (!st.isFile() || st.size < MIN) return next();
    let hit = cache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs) {
      hit = { mtime: st.mtimeMs, gz: zlib.gzipSync(fs.readFileSync(file), { level: 9 }), etag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}-gz"` };
      cache.set(file, hit);
    }
    res.set({ 'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': hit.gz.length, ETag: hit.etag, 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'public, max-age=3600', ...headers(file) });
    res.vary('Accept-Encoding');
    if (req.fresh) return res.status(304).end();
    res.end(req.method === 'HEAD' ? undefined : hit.gz);
  };
}
