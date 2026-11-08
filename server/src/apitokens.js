// Personal API tokens: scripts (a backup job, an upload from a scanner, a report) use the same API
// as the web app with `Authorization: Bearer nwt_…` instead of signing in. Each token belongs to
// one person and acts as them, can be read-only, expires, and can be revoked by its owner or the
// company's admins. Only a hash is kept; the token is shown once. Companies turn them on in
// Admin → Company settings (off until then). Tokens can't sign in, change the account, or make
// more tokens (/api/auth and /api/tokens need a real sign-in).
import crypto from 'node:crypto';
import { Router } from 'express';
import { q } from './db.js';
import { uid, now, str, bad, notFound, HttpError } from './util.js';
import { audit } from './audit.js';
import { requireAdmin } from './auth.js';

q(`CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,              -- the last 4 characters, to tell tokens apart
  scope TEXT NOT NULL,             -- read | write
  created_at INTEGER NOT NULL,
  expires_at INTEGER,              -- null: never
  last_used_at INTEGER,
  last_ip TEXT
)`).run();
q('CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id)').run();
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'allow_api_tokens')) q('ALTER TABLE orgs ADD COLUMN allow_api_tokens INTEGER NOT NULL DEFAULT 0').run();

export const PREFIX = 'nwt_';
export const SCOPES = ['read', 'write'];
export const EXPIRY_DAYS = [30, 90, 365, 0]; // 0: never
const MAX_TOKENS = 20;
const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** The bearer token in a request, if it looks like one of ours. */
export function bearerOf(req) {
  const m = /^Bearer\s+(nwt_[A-Za-z0-9_-]{20,100})\s*$/.exec(req.get?.('authorization') || req.headers?.authorization || '');
  return m ? m[1] : null;
}

/**
 * The token's row, when it's valid: not expired, its owner active, and their company allowing
 * tokens. Notes when it was last used (at most once a minute).
 */
export function tokenRow(token, ip = null) {
  if (!token) return null;
  const row = q(`SELECT t.*, u.disabled, o.allow_api_tokens FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN orgs o ON o.id = u.org_id WHERE t.hash = ?`).get(hashOf(token));
  if (!row || row.disabled || !row.allow_api_tokens || (row.expires_at && row.expires_at < now())) return null;
  if (!row.last_used_at || now() - row.last_used_at > 60e3) q('UPDATE api_tokens SET last_used_at = ?, last_ip = ? WHERE id = ?').run(now(), ip, row.id);
  return row;
}

/** What a token may do with this request: null when allowed, or why not. */
export function tokenRefusal(row, req) {
  const path = req.originalUrl.split('?')[0];
  if (/^\/api\/(auth|tokens)(\/|$)/.test(path)) return 'API tokens can’t be used for this: sign in instead';
  if (row.scope === 'read' && !['GET', 'HEAD'].includes(req.method)) return 'This token is read-only';
  return null;
}

const shape = (t) => ({ id: t.id, name: t.name, hint: t.hint, scope: t.scope, created_at: t.created_at, expires_at: t.expires_at, last_used_at: t.last_used_at, last_ip: t.last_ip, expired: !!(t.expires_at && t.expires_at < now()) });

export function apiTokenRoutes() {
  const r = Router();
  const allowed = (orgId) => !!q('SELECT allow_api_tokens FROM orgs WHERE id = ?').get(orgId)?.allow_api_tokens;

  r.get('/', (req, res) => {
    res.json({ allowed: allowed(req.user.org_id), tokens: q('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map(shape) });
  });

  r.post('/', (req, res) => {
    if (!allowed(req.user.org_id)) throw new HttpError(403, 'Your company hasn’t turned on API tokens (Admin → Company settings)');
    const name = str(req.body?.name, { required: true, name: 'Name', max: 80 });
    const scope = req.body?.scope ?? 'read';
    if (!SCOPES.includes(scope)) throw bad('Access must be read or write');
    const days = Number(req.body?.days ?? 90);
    if (!EXPIRY_DAYS.includes(days)) throw bad('Expiry must be 30, 90 or 365 days, or never (0)');
    if (q('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(req.user.id).n >= MAX_TOKENS) throw bad(`You can have ${MAX_TOKENS} tokens at most: revoke one first`);
    const token = PREFIX + crypto.randomBytes(30).toString('base64url');
    const id = uid();
    q('INSERT INTO api_tokens (id, user_id, name, hash, hint, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, name, hashOf(token), token.slice(-4), scope, now(), days ? now() + days * 864e5 : null);
    audit(req, 'api_token.create', { target: name, details: { scope, days: days || 'never' } });
    res.status(201).json({ ...shape(q('SELECT * FROM api_tokens WHERE id = ?').get(id)), token });
  });

  r.delete('/:id', (req, res) => {
    const t = q('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!t) throw notFound('Token not found');
    q('DELETE FROM api_tokens WHERE id = ?').run(t.id);
    audit(req, 'api_token.revoke', { target: t.name });
    res.json({ ok: true });
  });

  // Admins: everyone's tokens in the company, and revoking any of them.
  r.get('/company', requireAdmin, (req, res) => {
    res.json(q(`SELECT t.*, u.name AS user_name, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE u.org_id = ? ORDER BY t.created_at DESC`)
      .all(req.user.org_id).map((t) => ({ ...shape(t), user_name: t.user_name, username: t.username })));
  });
  r.delete('/company/:id', requireAdmin, (req, res) => {
    const t = q('SELECT t.*, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND u.org_id = ?').get(req.params.id, req.user.org_id);
    if (!t) throw notFound('Token not found');
    q('DELETE FROM api_tokens WHERE id = ?').run(t.id);
    audit(req, 'api_token.revoke', { target: `${t.name} (${t.username})` });
    res.json({ ok: true });
  });
  return r;
}
