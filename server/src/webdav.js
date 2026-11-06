// Drive as a network drive (WebDAV), for Finder (macOS: Go → Connect to Server), File Explorer
// (Windows: Map network drive), Linux file managers and phone file apps. Mounted at /dav/files.
//
//   /dav/files/                      My Drive, plus "Shared with me"
//   /dav/files/Projects/plan.pdf     a file in My Drive
//   /dav/files/Shared with me/...    files and folders others shared with you
//
// Same sign-in as calendar sync (email + password, or the mail-app password with two-step
// verification). Viewers can read; editors can change. Saving over a file keeps the old one as a
// version; deleting moves to the trash. Docs, Sheets and Slides stay in the browser and aren't listed.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, tx, FILES_DIR } from './db.js';
import { uid, now, HttpError, mimeFor } from './util.js';
import { roleFor, atLeast, audienceFor, subtreeIds } from './access.js';
import { authenticate } from './dav.js';
import { insertFile, receiveUpload, snapshot } from './routes/files.js';
import { indexSoon } from './search.js';
import { checkQuota, orgStorageUsed, orgSettings } from './tenancy.js';
import { sendTo } from './hub.js';
import { parseXml, elements, is, key, innerXml, element } from './davxml.js';
import * as L from './davlocks.js';

/**
 * A lock key for what a path names, the same for everyone who can reach it (a shared folder has a
 * different path for its owner and for the people it's shared with): the chain of file ids.
 */
function lockKey(node, user) {
  if (node.type === 'root') return `/u:${user.id}`;
  if (node.type === 'shared') return `/s:${user.id}`;
  if (node.type === 'missing') return `${lockKey(node.parent, user)}/n:${node.name}`;
  if (node.type !== 'item') return '/gone';
  const ids = [];
  for (let cur = node.row, d = 0; cur && d < 64; d++) { ids.unshift(cur.id); cur = cur.parent_id ? q('SELECT id, parent_id FROM files WHERE id = ?').get(cur.parent_id) : null; }
  return `/${ids.join('/')}`;
}

// Properties apps store on files and folders ("dead" properties, e.g. Windows file times).
q(`CREATE TABLE IF NOT EXISTS webdav_props (
  target TEXT NOT NULL,     -- a file id, or 'root:<user>' / 'shared:<user>' for the two top folders
  ns TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (target, ns, name)
)`).run();
const targetOf = (node, user) => (node.type === 'item' ? node.row.id : `${node.type}:${user.id}`);
const deadProps = (target) => q('SELECT ns, name, value FROM webdav_props WHERE target = ?').all(target);

const SHARED = 'Shared with me';
// System clutter that file managers write next to every file: accepted, but not kept.
const JUNK = /^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini|\.localized)$/i;
const NAME_OK = (n) => n && n.length <= 255 && !/[\/\\\0]/.test(n) && n !== '.' && n !== '..';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const etag = (f) => `"${f.id}-${f.version}"`;
const LINKABLE = "kind IN ('file', 'folder') AND trashed = 0";

/** What a path names: { type: 'root' | 'shared' | 'item' | 'missing', row, role, parent } */
function resolve(user, segments) {
  if (!segments.length) return { type: 'root' };
  let parent = { type: 'root' };
  let i = 0;
  if (segments[0] === SHARED) {
    if (segments.length === 1) return { type: 'shared' };
    parent = { type: 'shared' };
    i = 1;
  }
  for (; i < segments.length; i++) {
    const name = segments[i];
    let row;
    if (parent.type === 'root') row = q(`SELECT * FROM files WHERE owner_id = ? AND parent_id IS NULL AND name = ? AND ${LINKABLE}`).get(user.id, name);
    else if (parent.type === 'shared') row = sharedWithMe(user).find((f) => f.name === name);
    else row = q(`SELECT * FROM files WHERE parent_id = ? AND name = ? AND ${LINKABLE}`).get(parent.row.id, name);
    if (!row) return i === segments.length - 1 ? { type: 'missing', name, parent } : { type: 'gone' };
    const role = roleFor(row.id, user.id);
    if (!role) return { type: 'gone' };
    const node = { type: 'item', row, role, parent };
    if (i < segments.length - 1 && row.kind !== 'folder') return { type: 'gone' };
    parent = node;
  }
  return parent;
}
const sharedWithMe = (user) => q(`SELECT f.* FROM files f JOIN shares s ON s.file_id = f.id WHERE s.user_id = ? AND f.${LINKABLE.replace(/ AND /, ' AND f.')} ORDER BY f.name`).all(user.id)
  .filter((f) => roleFor(f.id, user.id));
const childrenOf = (user, node) => (node.type === 'root'
  ? q(`SELECT * FROM files WHERE owner_id = ? AND parent_id IS NULL AND ${LINKABLE} ORDER BY name`).all(user.id)
  : node.type === 'shared' ? sharedWithMe(user)
  : q(`SELECT * FROM files WHERE parent_id = ? AND ${LINKABLE} ORDER BY name`).all(node.row.id));

/** Can this user add things in this folder (node)? Where do new items go, and who owns them? */
function placeFor(user, node) {
  if (node.type === 'root') return { parentId: null, owner: user.id };
  if (node.type === 'item' && node.row.kind === 'folder' && atLeast(node.role, 'editor')) return { parentId: node.row.id, owner: user.id };
  return null;
}

/** The properties Drive itself provides, as { '{ns}name': inner XML }. */
function liveProps(f, user, isRoot, lockXml = '') {
  const coll = !f || f.kind === 'folder';
  const p = {
    '{DAV:}displayname': esc(f ? f.name : isRoot ? 'Workspace Drive' : SHARED),
    '{DAV:}resourcetype': coll ? '<d:collection/>' : '',
    '{DAV:}supportedlock': '<d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry>',
    '{DAV:}lockdiscovery': lockXml,
  };
  if (f) {
    p['{DAV:}getlastmodified'] = new Date(f.updated_at).toUTCString();
    p['{DAV:}creationdate'] = new Date(f.created_at).toISOString();
    p['{DAV:}getetag'] = esc(etag(f));
    if (!coll) { p['{DAV:}getcontentlength'] = String(f.size); p['{DAV:}getcontenttype'] = esc(f.mime || 'application/octet-stream'); }
  }
  if (isRoot) {
    // Free space as the file manager shows it: the company's quota if it has one.
    const used = orgStorageUsed(user.org_id);
    const quota = (orgSettings(user.org_id)?.quota_mb || 0) * 1048576;
    p['{DAV:}quota-used-bytes'] = String(used);
    if (quota) p['{DAV:}quota-available-bytes'] = String(Math.max(0, quota - used));
  }
  return p;
}
const LIVE = new Set(['getlastmodified', 'creationdate', 'getetag', 'getcontentlength', 'getcontenttype', 'resourcetype', 'supportedlock', 'lockdiscovery', 'displayname', 'quota-used-bytes', 'quota-available-bytes'].map((n) => `{DAV:}${n}`));
const splitKey = (k) => { const m = /^\{(.*)\}(.*)$/.exec(k); return [m[1], m[2]]; };

/** One <response>: `want` is null (all), 'names' (names only), or a list of '{ns}name'. */
function propResponse(href, live, dead, want) {
  const all = { ...live };
  for (const d of dead) all[`{${d.ns}}${d.name}`] = d.value;
  const found = [], missing = [];
  const keys = want === null || want === 'names' ? Object.keys(all) : want;
  for (const k of keys) {
    const [ns, name] = splitKey(k);
    if (k in all) found.push(element(ns, name, want === 'names' ? '' : all[k])); else missing.push(element(ns, name));
  }
  const stat = (list, code) => (list.length ? `<d:propstat><d:prop>${list.join('')}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat>` : '');
  return `<d:response><d:href>${esc(href)}</d:href>${stat(found, '200 OK')}${stat(missing, '404 Not Found')}</d:response>`;
}

const readBody = (req) => new Promise((ok, fail) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 1e6) { fail(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', fail);
});
const changed = (fileIds) => { for (const id of fileIds) sendTo(audienceFor(id), { type: 'files-changed' }); };

export default function webdavRoutes({ maxUploadBytes }) {
  const r = Router();
  r.use((req, res, next) => { if (/^(PUT|MOVE|COPY|DELETE)$/.test(req.method)) res.on('finish', () => { if (res.statusCode < 300) indexSoon(); }); next(); }); // search catches up
  r.use(async (req, res, next) => {
    try {
      res.setHeader('DAV', '1, 2');
      res.setHeader('MS-Author-Via', 'DAV');
      res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK');
      if (req.method === 'OPTIONS') return res.status(200).end();
      let user;
      try { user = authenticate(req); } catch (e) { return res.status(e.status || 500).end(); }
      if (!user) { res.setHeader('WWW-Authenticate', 'Basic realm="Workspace", charset="UTF-8"'); return res.status(401).send('Sign in with your email address and password (or your mail-app password)'); }

      // A '#' never belongs in a request; refusing it keeps "folder#x" from meaning "folder".
      if (req.originalUrl.includes('#')) return res.status(400).end();
      const base = req.baseUrl; // "/dav/files"
      const segs = req.path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      const hrefOf = (parts, coll) => `${base}/${parts.map(encodeURIComponent).join('/')}${coll && parts.length ? '/' : ''}`;
      const node = resolve(user, segs);
      const m = req.method;
      const lastName = segs[segs.length - 1];
      const keyHere = lockKey(node, user);
      const lockXmlOf = (k) => L.locksOn(k).map((l) => L.activeLockXml(l, esc)).join('');
      // Writes check locks and If conditions: 423 when locked without the token, 412 when an If fails.
      const etagByKey = new Map([[keyHere, node.type === 'item' ? etag(node.row) : null]]);
      const pathOfUrl = (u) => {
        let pth; try { pth = new URL(u, 'http://x').pathname; } catch { return '/bad'; }
        if (!pth.startsWith(base)) return '/elsewhere';
        const n = resolve(user, pth.slice(base.length).split('/').filter(Boolean).map((x) => decodeURIComponent(x)));
        const k = lockKey(n, user);
        etagByKey.set(k, n.type === 'item' ? etag(n.row) : null);
        return k;
      };
      const guard = (keys, deep = false) => {
        const code = L.checkWrite(req, keys, { etagOf: (k) => etagByKey.get(k) ?? null, pathOfUrl, deep });
        if (code !== 200) { res.status(code).end(); return false; }
        return true;
      };

      if (m === 'PROPFIND') {
        if (node.type === 'missing' || node.type === 'gone') return res.status(404).end();
        const body = await readBody(req);
        let want = null;
        if (body.trim()) {
          const doc = parseXml(body);
          if (!doc || !is(doc, 'DAV:', 'propfind')) return res.status(400).end();
          const [first] = elements(doc);
          if (is(first, 'DAV:', 'propname')) want = 'names';
          else if (is(first, 'DAV:', 'prop')) want = elements(first).map(key);
        }
        const out = [];
        const self = node.type === 'item' ? node.row : null;
        out.push(propResponse(hrefOf(segs, !self || self.kind === 'folder'), liveProps(self, user, node.type === 'root', lockXmlOf(keyHere)), deadProps(targetOf(node, user)), want));
        if (req.get('depth') !== '0' && (!self || self.kind === 'folder')) {
          if (node.type === 'root') out.push(propResponse(hrefOf([SHARED], true), liveProps(null, user, false), deadProps(`shared:${user.id}`), want));
          for (const c of childrenOf(user, node)) out.push(propResponse(hrefOf([...segs, c.name], c.kind === 'folder'), liveProps(c, user, false, lockXmlOf(lockKey({ type: 'item', row: c }, user))), deadProps(c.id), want));
        }
        return res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${out.join('')}</d:multistatus>`);
      }

      if (m === 'GET' || m === 'HEAD') {
        if (node.type !== 'item') {
          if (node.type === 'root' || node.type === 'shared' || node.row?.kind === 'folder') return res.type('text/plain').send(m === 'HEAD' ? '' : 'Workspace Drive. Connect to this address as a network drive in Finder or File Explorer.');
          return res.status(404).end();
        }
        if (node.row.kind === 'folder') return res.type('text/plain').send('');
        res.setHeader('ETag', etag(node.row));
        res.setHeader('Last-Modified', new Date(node.row.updated_at).toUTCString());
        res.setHeader('Content-Type', node.row.mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(node.row.name)}`);
        return res.sendFile(path.join(FILES_DIR, node.row.storage), { headers: { 'Cache-Control': 'private, max-age=0' }, lastModified: false, etag: false });
      }

      if (m === 'PROPPATCH') {
        if (node.type === 'missing' || node.type === 'gone') return res.status(404).end();
        if (node.type === 'item' && !atLeast(node.role, 'editor')) return res.status(403).end();
        if (!guard([keyHere])) return;
        const doc = parseXml(await readBody(req));
        if (!doc || !is(doc, 'DAV:', 'propertyupdate')) return res.status(400).end();
        // In document order: set and remove; Drive's own properties can't be changed, and then nothing is.
        const ops = [];
        for (const op of elements(doc)) {
          const kind = is(op, 'DAV:', 'set') ? 'set' : is(op, 'DAV:', 'remove') ? 'remove' : null;
          const prop = elements(op).find((e) => is(e, 'DAV:', 'prop'));
          if (!kind || !prop) return res.status(400).end();
          for (const p of elements(prop)) ops.push({ kind, k: key(p), ns: p.ns, name: p.local, value: innerXml(p) });
        }
        const blocked = ops.some((o) => LIVE.has(o.k));
        const target = targetOf(node, user);
        if (!blocked) tx(() => { for (const o of ops) {
          if (o.kind === 'set') q('INSERT INTO webdav_props (target, ns, name, value) VALUES (?, ?, ?, ?) ON CONFLICT (target, ns, name) DO UPDATE SET value = excluded.value').run(target, o.ns, o.name, o.value);
          else q('DELETE FROM webdav_props WHERE target = ? AND ns = ? AND name = ?').run(target, o.ns, o.name);
        } });
        const rows = ops.map((o) => `<d:propstat><d:prop>${element(o.ns, o.name)}</d:prop><d:status>HTTP/1.1 ${blocked ? (LIVE.has(o.k) ? '403 Forbidden' : '424 Failed Dependency') : '200 OK'}</d:status></d:propstat>`);
        return res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>${esc(req.baseUrl + req.path)}</d:href>${rows.join('')}</d:response></d:multistatus>`);
      }

      if (m === 'LOCK') {
        if (node.type === 'gone') return res.status(409).end();
        const body = await readBody(req);
        const timeout = L.timeoutOf(req.get('timeout'));
        const send = (l, status, created) => {
          l.href = req.baseUrl + req.path;
          if (created !== undefined) res.setHeader('Lock-Token', `<${l.token}>`);
          return res.status(status).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery>${L.activeLockXml(l, esc)}</d:lockdiscovery></d:prop>`);
        };
        if (!body.trim()) {
          // Refreshing a lock: its token comes in the If header.
          const token = (req.get('if') || '').match(/<(opaquelocktoken:[^>]+)>/)?.[1];
          const l = token && L.refresh(token, keyHere, timeout);
          return l ? send(l, 200) : res.status(412).end();
        }
        const doc = parseXml(body);
        if (!doc || !is(doc, 'DAV:', 'lockinfo')) return res.status(400).end();
        const scopeEl = elements(doc).find((e) => is(e, 'DAV:', 'lockscope'));
        const scope = scopeEl && elements(scopeEl).some((e) => is(e, 'DAV:', 'shared')) ? 'shared' : 'exclusive';
        const ownerEl = elements(doc).find((e) => is(e, 'DAV:', 'owner'));
        const depth = req.get('depth') === '0' ? '0' : 'infinity';
        if (node.type === 'item' && !atLeast(node.role, 'editor')) return res.status(403).end();
        let k = keyHere, created = false;
        if (node.type === 'missing') {
          // Locking a name that doesn't exist yet makes an empty file there (RFC 4918 §9.10.4).
          if (!NAME_OK(node.name)) return res.status(409).end();
          const place = placeFor(user, node.parent);
          if (!place) return res.status(403).end();
          if (!guard([keyHere])) return;
          const storage = uid();
          fs.writeFileSync(path.join(FILES_DIR, storage), '');
          const id = insertFile({ owner: place.owner, parentId: place.parentId, name: node.name, kind: 'file', mime: mimeFor(node.name), size: 0, storage });
          k = lockKey({ type: 'item', row: q('SELECT * FROM files WHERE id = ?').get(id) }, user);
          created = true;
          changed([id]);
        }
        const l = L.lock(k, { scope, depth, owner: ownerEl ? innerXml(ownerEl) : '', timeout, userId: user.id });
        if (!l) return res.status(423).end();
        return send(l, created ? 201 : 200, true);
      }
      if (m === 'UNLOCK') {
        const token = (req.get('lock-token') || '').replace(/^<|>$/g, '');
        return res.status(token && L.unlock(token, keyHere) ? 204 : 409).end();
      }

      if (m === 'PUT') {
        if (JUNK.test(lastName || '')) { req.resume(); return res.status(201).end(); }
        if (!guard([keyHere])) { req.resume(); return; }
        if (node.type === 'item') {
          if (node.row.kind !== 'file') return res.status(405).end();
          if (!atLeast(node.role, 'editor')) return res.status(403).send('View only');
          const owner = q('SELECT org_id FROM users WHERE id = ?').get(node.row.owner_id);
          const { storage, size } = await receiveUpload(req, owner.org_id, maxUploadBytes);
          tx(() => {
            // Apps often write an empty file first and then the content: don't keep the empty one as a version.
            if (node.row.size > 0) snapshot(node.row.id);
            q('UPDATE files SET storage = ?, size = ?, mime = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
              .run(storage, size, mimeFor(node.row.name), now(), user.id, node.row.id);
          });
          if (node.row.size === 0 && node.row.storage) fs.rm(path.join(FILES_DIR, node.row.storage), { force: true }, () => {});
          changed([node.row.id]);
          const after = q('SELECT * FROM files WHERE id = ?').get(node.row.id);
          res.setHeader('ETag', etag(after));
          return res.status(204).end();
        }
        if (node.type !== 'missing' || !NAME_OK(node.name)) return res.status(409).end();
        const place = placeFor(user, node.parent);
        if (!place) return res.status(403).send('You can\'t add files here');
        const { storage, size } = await receiveUpload(req, user.org_id, maxUploadBytes);
        const id = insertFile({ owner: place.owner, parentId: place.parentId, name: node.name, kind: 'file', mime: mimeFor(node.name), size, storage });
        changed([id]);
        res.setHeader('ETag', etag(q('SELECT * FROM files WHERE id = ?').get(id)));
        return res.status(201).end();
      }

      if (m === 'MKCOL') {
        // A body would ask for something we don't do (RFC 4918 9.3): refuse it.
        if ((await readBody(req)).length) return res.status(415).end();
        if (!guard([keyHere])) return;
        if (node.type !== 'missing' || !NAME_OK(node.name)) return res.status(node.type === 'item' ? 405 : 409).end();
        const place = placeFor(user, node.parent);
        if (!place) return res.status(403).end();
        const id = insertFile({ owner: place.owner, parentId: place.parentId, name: node.name, kind: 'folder' });
        changed([id]);
        return res.status(201).end();
      }

      if (m === 'DELETE') {
        if (JUNK.test(lastName || '')) return res.status(204).end();
        if (node.type !== 'item') return res.status(node.type === 'missing' ? 404 : 403).end();
        if (!atLeast(node.role, 'editor')) return res.status(403).end();
        if (!guard([keyHere], true)) return;
        // To the trash, like deleting in Drive: it can be restored there.
        q('UPDATE files SET trashed = 1, updated_at = ? WHERE id = ?').run(now(), node.row.id);
        L.dropWithin(keyHere);
        changed([node.row.id]);
        return res.status(204).end();
      }

      if (m === 'MOVE' || m === 'COPY') {
        if (node.type !== 'item') return res.status(node.type === 'missing' ? 404 : 403).end();
        const dest = req.get('destination');
        let destSegs;
        try { destSegs = new URL(dest, 'http://x').pathname.slice(base.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch { return res.status(400).end(); }
        if (!dest || !new URL(dest, 'http://x').pathname.startsWith(`${base}/`) || !destSegs.length) return res.status(400).end();
        const target = resolve(user, destSegs);
        const newName = destSegs[destSegs.length - 1];
        if (!NAME_OK(newName)) return res.status(400).end();
        const overwrite = req.get('overwrite') !== 'F';
        if (target.type === 'item') {
          if (target.row.id === node.row.id) return res.status(403).end();
          if (!overwrite) return res.status(412).end();
          if (!atLeast(target.role, 'editor')) return res.status(403).end();
        } else if (target.type !== 'missing') return res.status(409).end();
        const parentNode = target.parent;
        const place = placeFor(user, parentNode);
        if (!place) return res.status(403).end();
        const destKey = lockKey(target, user);
        if (m === 'MOVE' ? !guard([keyHere, destKey], true) : !guard([destKey], true)) return;
        if (m === 'MOVE') {
          if (!atLeast(node.role, 'editor')) return res.status(403).end();
          if (place.parentId === null && node.row.owner_id !== user.id) return res.status(403).send('Only the owner can move this to My Drive');
          if (node.row.kind === 'folder' && place.parentId && subtreeIds(node.row.id).includes(place.parentId)) return res.status(409).end();
          tx(() => {
            if (target.type === 'item') q('UPDATE files SET trashed = 1, updated_at = ? WHERE id = ?').run(now(), target.row.id);
            q('UPDATE files SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(newName, place.parentId, now(), node.row.id);
          });
          L.dropWithin(keyHere);
          changed([node.row.id]);
          return res.status(target.type === 'item' ? 204 : 201).end();
        }
        // COPY: a file, or a folder with everything in it (Depth: 0 copies just the folder).
        if (node.row.kind === 'folder' && place.parentId && subtreeIds(node.row.id).includes(place.parentId)) return res.status(409).end();
        const shallow = req.get('depth') === '0';
        const total = node.row.kind === 'file' ? node.row.size
          : shallow ? 0 : q(`SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE id IN (${subtreeIds(node.row.id).map(() => '?').join(',')}) AND kind = 'file' AND trashed = 0`).get(...subtreeIds(node.row.id)).n;
        checkQuota(user.org_id, total);
        if (target.type === 'item') q('UPDATE files SET trashed = 1, updated_at = ? WHERE id = ?').run(now(), target.row.id);
        const copy = (f, parentId, name) => {
          const keepProps = (id) => { q('INSERT INTO webdav_props (target, ns, name, value) SELECT ?, ns, name, value FROM webdav_props WHERE target = ?').run(id, f.id); return id; };
          if (f.kind === 'file') {
            const storage = uid();
            fs.copyFileSync(path.join(FILES_DIR, f.storage), path.join(FILES_DIR, storage));
            return keepProps(insertFile({ owner: place.owner, parentId, name, kind: 'file', mime: f.mime, size: f.size, storage }));
          }
          const id = keepProps(insertFile({ owner: place.owner, parentId, name, kind: 'folder' }));
          if (!shallow) for (const c of q(`SELECT * FROM files WHERE parent_id = ? AND ${LINKABLE}`).all(f.id)) copy(c, id, c.name);
          return id;
        };
        const id = copy(node.row, place.parentId, newName);
        changed([id]);
        return res.status(target.type === 'item' ? 204 : 201).end();
      }
      return res.status(405).end();
    } catch (e) { next(e); }
  });
  r.use((err, req, res, next) => { const status = err.status || 500; if (status >= 500) console.error('[webdav]', err); res.status(status).type('text/plain').send(status >= 500 ? 'Server error' : err.message); });
  return r;
}
