// WebDAV locks (RFC 4918 §6–7, §10.4): exclusive and shared write locks on a path, depth 0 or
// infinity (a folder lock covers everything inside), with timeouts. Writes to a locked path need
// the lock's token in the If header; If conditions (tokens, ETags, Not, tagged lists) are checked.
import crypto from 'node:crypto';

const MAX_TIMEOUT = 3600, DEFAULT_TIMEOUT = 600;
const locks = new Map(); // token -> { token, path, scope, depth, owner, expires, userId }

const norm = (p) => '/' + p.split('/').filter(Boolean).join('/');
const covers = (lock, p) => lock.path === p || (lock.depth === 'infinity' && (p.startsWith(`${lock.path}/`) || lock.path === '/'));
function live() { const t = Date.now(); for (const [k, l] of locks) if (l.expires < t) locks.delete(k); return [...locks.values()]; }

/** Locks that apply to a path (its own, and depth-infinity locks on folders above it). */
export const locksOn = (path) => live().filter((l) => covers(l, norm(path)));
/** Locks on a path or anywhere inside it (deleting or moving a folder needs all of their tokens). */
const locksWithin = (path) => { const p = norm(path); return live().filter((l) => covers(l, p) || l.path.startsWith(`${p === '/' ? '' : p}/`)); };

export function timeoutOf(header) {
  const m = /Second-(\d+)/i.exec(header || '');
  return Math.min(MAX_TIMEOUT, m ? Number(m[1]) : /infinite/i.test(header || '') ? MAX_TIMEOUT : DEFAULT_TIMEOUT);
}

/** Take a lock, or null if a conflicting one is held (an exclusive lock conflicts with any other). */
export function lock(path, { scope, depth, owner, timeout, userId }) {
  const p = norm(path);
  const clash = live().filter((l) => covers(l, p) || (depth === 'infinity' && l.path.startsWith(`${p === '/' ? '' : p}/`)));
  if (clash.some((l) => l.scope === 'exclusive' || scope === 'exclusive')) return null;
  const l = { token: `opaquelocktoken:${crypto.randomUUID()}`, path: p, scope, depth, owner, userId, timeout, expires: Date.now() + timeout * 1000 };
  locks.set(l.token, l);
  return l;
}
export function refresh(token, path, timeout) {
  const l = locks.get(token);
  if (!l || l.expires < Date.now() || !covers(l, norm(path))) return null;
  l.timeout = timeout; l.expires = Date.now() + timeout * 1000;
  return l;
}
export function unlock(token, path) {
  const l = locks.get(token);
  if (!l || !covers(l, norm(path))) return false;
  locks.delete(token);
  return true;
}
/** After a resource moves or is deleted, its locks go (RFC 4918 §7.6). */
export function dropWithin(path) { for (const l of locksWithin(path)) locks.delete(l.token); }

/** Parse the If header into lists: [{ resource|null, conditions: [{ not, token?, etag? }] }]. */
export function parseIf(header) {
  if (!header) return null;
  const out = [];
  let resource = null;
  const re = /\s*(?:<([^>]*)>|\(([^)]*)\))/y;
  let m, pos = 0;
  while (pos < header.length) {
    re.lastIndex = pos;
    m = re.exec(header);
    if (!m) { if (header.slice(pos).trim()) return 'bad'; break; }
    pos = re.lastIndex;
    if (m[1] !== undefined) { resource = m[1]; continue; }
    const conditions = [];
    const cre = /\s*(Not\s+)?(?:<([^>]*)>|\[([^\]]*)\])/iy;
    let c, cpos = 0;
    const body = m[2];
    while (cpos < body.length) {
      cre.lastIndex = cpos;
      c = cre.exec(body);
      if (!c) { if (body.slice(cpos).trim()) return 'bad'; break; }
      cpos = cre.lastIndex;
      conditions.push({ not: !!c[1], token: c[2], etag: c[3] });
    }
    if (!conditions.length) return 'bad';
    out.push({ resource, conditions });
  }
  return out.length ? out : 'bad';
}

/**
 * Check a write to `paths` (all must be unlocked or unlocked by a submitted token).
 * `etagOf(path)` gives the current ETag for If [etag] conditions; `pathOfUrl` turns a tagged
 * resource URL into a path. Returns 200, 412 (If not satisfied) or 423 (locked).
 */
export function checkWrite(req, paths, { etagOf, pathOfUrl, deep = false }) {
  const lists = parseIf(req.get('if'));
  if (lists === 'bad') return 400;
  const requestPath = paths[0];
  const submitted = new Set();
  if (lists) {
    let anyTrue = false;
    for (const list of lists) {
      const p = list.resource ? pathOfUrl(list.resource) : requestPath;
      const tokens = new Set(locksOn(p).map((l) => l.token));
      const ok = list.conditions.every((c) => {
        const hit = c.token !== undefined ? tokens.has(c.token) : c.etag === etagOf(p);
        return c.not ? !hit : hit;
      });
      if (ok) anyTrue = true;
      for (const c of list.conditions) if (c.token && !c.not) submitted.add(c.token);
    }
    if (!anyTrue) return 412;
  }
  for (const p of paths) {
    const needed = deep ? locksWithin(p) : locksOn(p);
    if (needed.some((l) => !submitted.has(l.token))) return 423;
  }
  return 200;
}

export function activeLockXml(l, esc) {
  return `<d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:${l.scope}/></d:lockscope><d:depth>${l.depth === 'infinity' ? 'infinity' : '0'}</d:depth>${l.owner ? `<d:owner>${l.owner}</d:owner>` : ''}<d:timeout>Second-${Math.max(0, Math.round((l.expires - Date.now()) / 1000))}</d:timeout><d:locktoken><d:href>${l.token}</d:href></d:locktoken><d:lockroot><d:href>${esc(l.href || l.path)}</d:href></d:lockroot></d:activelock>`;
}
export function resetLocks() { locks.clear(); }
