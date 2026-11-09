// "Sign in with Workspace": an OpenID Connect provider, so other apps a company runs (Nextcloud,
// Gitea, Grafana, a wiki…) can let people sign in with their Workspace account.
//
// An admin registers each app (its name and the addresses it may send people back to) and gets a
// client ID and secret to put in that app. The authorization-code flow is used (with PKCE when the
// app sends it): the app sends the person to /oauth/authorize, they say yes once (Workspace remembers),
// the app swaps the code for an ID token (RS256, keys at /oauth/jwks) and can ask /oauth/userinfo.
// Only people in the company that registered the app can sign in to it.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { q } from './db.js';
import { uid, now, bad, notFound, HttpError } from './util.js';
import { audit } from './audit.js';

q(`CREATE TABLE IF NOT EXISTS oidc_clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,          -- JSON ["https://cloud.example.com/apps/oidc/callback"]
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
)`).run();
q(`CREATE TABLE IF NOT EXISTS oidc_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  nonce TEXT,
  challenge TEXT,
  challenge_method TEXT,
  expires_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS oidc_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`).run();
// Refresh tokens (scope offline_access): the app stays signed in for up to REFRESH_TTL without
// sending the person back; each use gives a new one and retires the old.
q(`CREATE TABLE IF NOT EXISTS oidc_refresh (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS oidc_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
)`).run();
q(`CREATE TABLE IF NOT EXISTS oidc_keys (
  kid TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();

// Who may use an app: everyone in the company, or only people in some of its groups (JSON [group ids]).
if (!q('PRAGMA table_info(oidc_clients)').all().some((c) => c.name === 'allowed_groups')) q('ALTER TABLE oidc_clients ADD COLUMN allowed_groups TEXT').run();
// The app's own address (its home page), for the apps on Workspace's Home page.
if (!q('PRAGMA table_info(oidc_clients)').all().some((c) => c.name === 'home_url')) q('ALTER TABLE oidc_clients ADD COLUMN home_url TEXT').run();
/** Whether someone may sign in to an app. */
export function mayUse(c, user) {
  if (!user || user.org_id !== c.org_id) return false;
  const groups = c.allowed_groups ? JSON.parse(c.allowed_groups) : [];
  if (!groups.length) return true;
  return !!q('SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (SELECT value FROM json_each(?))').get(user.id, JSON.stringify(groups));
}

const CODE_TTL = 60e3, TOKEN_TTL = 3600e3, REFRESH_TTL = 30 * 864e5;
const SCOPES = ['openid', 'profile', 'email', 'groups', 'offline_access'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const issuerOf = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

/** The signing key (made once, kept in the database). */
function signingKey() {
  let row = q('SELECT * FROM oidc_keys ORDER BY created_at DESC LIMIT 1').get();
  if (!row) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    row = { kid: crypto.randomBytes(8).toString('hex'), private_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), created_at: now() };
    q('INSERT INTO oidc_keys (kid, private_pem, created_at) VALUES (?, ?, ?)').run(row.kid, row.private_pem, row.created_at);
  }
  return { kid: row.kid, key: crypto.createPrivateKey(row.private_pem) };
}
export function jwks() {
  return { keys: q('SELECT * FROM oidc_keys ORDER BY created_at DESC').all().map((r) => ({ ...crypto.createPublicKey(r.private_pem).export({ format: 'jwk' }), kid: r.kid, use: 'sig', alg: 'RS256' })) };
}
/** A signed JWT (RS256). */
export function signJwt(payload) {
  const { kid, key } = signingKey();
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

/** Scopes asked for, of the ones Workspace gives (openid always). */
export const scopesOf = (scope) => ['openid', ...String(scope || '').split(/\s+/).filter((s) => SCOPES.includes(s) && s !== 'openid')].filter((s, i, a) => a.indexOf(s) === i);

/** A redirect address an admin may register: https (or http on this machine / the local network), no fragment. */
export function cleanRedirect(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw bad(`Not a web address: ${u}`); }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw bad(`Use an https:// address (http only for this network): ${u}`);
  if (url.hash) throw bad(`No # part in a redirect address: ${u}`);
  return url.toString();
}

const clientBy = (clientId) => q('SELECT * FROM oidc_clients WHERE client_id = ?').get(String(clientId || ''));
const shapeClient = (c) => ({ id: c.id, name: c.name, client_id: c.client_id, redirect_uris: JSON.parse(c.redirect_uris), allowed_groups: c.allowed_groups ? JSON.parse(c.allowed_groups) : [], home_url: c.home_url || null, created_at: c.created_at, last_used_at: c.last_used_at });

/** What an app may learn about someone, by scope. */
function claimsFor(user, scopes) {
  const out = { sub: user.id };
  if (scopes.includes('profile')) Object.assign(out, { name: user.name, preferred_username: user.username.split('@')[0] });
  if (scopes.includes('email')) Object.assign(out, { email: user.username, email_verified: true });
  // Groups (Admin → Groups) by name, for apps that give roles by group (Grafana admins, wiki editors…).
  if (scopes.includes('groups')) out.groups = q('SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? AND g.org_id = ? ORDER BY g.name').all(user.id, user.org_id).map((g) => g.name);
  return out;
}

/** The endpoints other apps call (outside /api: no session, no browser header). */
export function oidcPublicRoutes() {
  const r = Router();
  r.get('/.well-known/openid-configuration', (req, res) => {
    const iss = issuerOf(req);
    res.json({
      issuer: iss, authorization_endpoint: `${iss}/oauth/authorize`, token_endpoint: `${iss}/oauth/token`, userinfo_endpoint: `${iss}/oauth/userinfo`, jwks_uri: `${iss}/oauth/jwks`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: SCOPES, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256', 'plain'],
      claims_supported: ['sub', 'name', 'preferred_username', 'email', 'email_verified', 'groups'],
    });
  });
  r.get('/oauth/jwks', (req, res) => { signingKey(); res.json(jwks()); });

  // The app sends the person here. A wrong client or return address is shown, never redirected to.
  r.get('/oauth/authorize', (req, res) => {
    const c = clientBy(req.query.client_id);
    const redirect = String(req.query.redirect_uri || '');
    if (!c || !JSON.parse(c.redirect_uris).includes(redirect)) return res.status(400).type('text').send('This sign-in link isn’t right: the app or its return address isn’t registered in Workspace.');
    const back = (params) => { const u = new URL(redirect); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v); return res.redirect(302, u.toString()); };
    if (req.query.response_type !== 'code') return back({ error: 'unsupported_response_type', state: req.query.state });
    if (!String(req.query.scope || '').split(/\s+/).includes('openid')) return back({ error: 'invalid_scope', error_description: 'openid is needed', state: req.query.state });
    // The person says yes (or signs in first) on Workspace's own page, which carries on from here.
    const qs = new URLSearchParams(Object.fromEntries(['client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'].filter((k) => req.query[k]).map((k) => [k, String(req.query[k])])));
    res.redirect(302, `/oauth/consent?${qs}`);
  });

  // The app swaps the code for tokens.
  r.post('/oauth/token', express.urlencoded({ extended: false, limit: '20kb' }), express.json({ limit: '20kb' }), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, error, description) => res.status(status).json({ error, ...(description && { error_description: description }) });
    let id = req.body?.client_id, secret = req.body?.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
    if (basic) { const [a, b] = Buffer.from(basic[1], 'base64').toString().split(':'); id = decodeURIComponent(a || ''); secret = decodeURIComponent(b || ''); }
    const c = clientBy(id);
    if (!c || !secret || sha(secret) !== c.secret_hash) return fail(401, 'invalid_client');
    const issue = (user, scope, nonce) => {
      const scopes = scope.split(' ');
      const access = crypto.randomBytes(32).toString('base64url');
      q('INSERT INTO oidc_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(access), c.client_id, user.id, scope, Date.now() + TOKEN_TTL);
      q('DELETE FROM oidc_tokens WHERE expires_at < ?').run(Date.now());
      q('DELETE FROM oidc_refresh WHERE expires_at < ?').run(Date.now());
      q('UPDATE oidc_clients SET last_used_at = ? WHERE id = ?').run(now(), c.id);
      let refresh = null;
      if (scopes.includes('offline_access')) {
        refresh = crypto.randomBytes(32).toString('base64url');
        q('INSERT INTO oidc_refresh (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(refresh), c.client_id, user.id, scope, Date.now() + REFRESH_TTL);
      }
      const t = Math.floor(Date.now() / 1000);
      const idToken = signJwt({ iss: issuerOf(req), aud: c.client_id, iat: t, exp: t + TOKEN_TTL / 1000, auth_time: t, ...(nonce && { nonce }), ...claimsFor(user, scopes) });
      res.json({ access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL / 1000, id_token: idToken, scope, ...(refresh && { refresh_token: refresh }) });
    };
    if (req.body?.grant_type === 'refresh_token') {
      // Still allowed (the grant not taken back, the person still active in the company): a fresh set.
      const old = q('SELECT * FROM oidc_refresh WHERE token_hash = ?').get(sha(req.body?.refresh_token || ''));
      if (old) q('DELETE FROM oidc_refresh WHERE token_hash = ?').run(old.token_hash); // used once
      const user = old && q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(old.user_id);
      const granted = old && q('SELECT 1 FROM oidc_grants WHERE user_id = ? AND client_id = ?').get(old.user_id, c.client_id);
      if (!old || old.client_id !== c.client_id || old.expires_at < Date.now() || !user || !mayUse(c, user) || !granted) return fail(400, 'invalid_grant', 'Sign in again');
      return issue(user, old.scope, null);
    }
    if (req.body?.grant_type !== 'authorization_code') return fail(400, 'unsupported_grant_type');
    const row = q('SELECT * FROM oidc_codes WHERE code_hash = ?').get(sha(req.body?.code || ''));
    if (row) q('DELETE FROM oidc_codes WHERE code_hash = ?').run(row.code_hash); // used once, whatever happens
    if (!row || row.client_id !== c.client_id || row.expires_at < Date.now()) return fail(400, 'invalid_grant', 'The code is wrong, used or expired');
    if (row.redirect_uri !== String(req.body?.redirect_uri || '')) return fail(400, 'invalid_grant', 'redirect_uri doesn’t match');
    if (row.challenge) {
      const v = String(req.body?.code_verifier || '');
      const ok = row.challenge_method === 'S256' ? b64url(crypto.createHash('sha256').update(v).digest()) === row.challenge : v === row.challenge;
      if (!v || !ok) return fail(400, 'invalid_grant', 'code_verifier doesn’t match');
    }
    const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(row.user_id);
    if (!user || !mayUse(c, user)) return fail(400, 'invalid_grant');
    issue(user, row.scope, row.nonce);
  });

  const userinfo = (req, res) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const row = m && q('SELECT * FROM oidc_tokens WHERE token_hash = ?').get(sha(m[1].trim()));
    if (!row || row.expires_at < Date.now()) return res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid_token' });
    const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(row.user_id);
    const app = clientBy(row.client_id);
    if (!user || !app || !mayUse(app, user)) return res.status(401).json({ error: 'invalid_token' });
    res.json(claimsFor(user, row.scope.split(' ')));
  };
  r.get('/oauth/userinfo', userinfo);
  r.post('/oauth/userinfo', userinfo);
  return r;
}

/** The consent page's calls, and admins' list of apps (under /api/oauth, signed in). */
export function oidcApiRoutes() {
  const r = Router();
  const loadRequest = (req, src) => {
    const c = clientBy(src.client_id);
    if (!c || !JSON.parse(c.redirect_uris).includes(String(src.redirect_uri || ''))) throw notFound('This app isn’t registered in Workspace');
    if (c.org_id !== req.user.org_id) throw new HttpError(403, 'This app is for another company: sign in with an account there');
    if (!mayUse(c, req.user)) throw new HttpError(403, `You aren’t one of the people allowed to use ${c.name}. Ask an administrator if you need it.`);
    return { c, scopes: scopesOf(src.scope) };
  };
  r.get('/request', (req, res) => {
    const { c, scopes } = loadRequest(req, req.query);
    const g = q('SELECT scope FROM oidc_grants WHERE user_id = ? AND client_id = ?').get(req.user.id, c.client_id);
    res.json({ app: c.name, scopes, granted: !!g && scopes.every((s) => g.scope.split(' ').includes(s)), host: new URL(String(req.query.redirect_uri)).host });
  });
  const redirectWith = (uri, params) => { const u = new URL(uri); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, String(v)); return u.toString(); };
  r.post('/approve', (req, res) => {
    const b = req.body || {};
    const { c, scopes } = loadRequest(req, b);
    const method = b.code_challenge ? (b.code_challenge_method === 'plain' ? 'plain' : 'S256') : null;
    const code = crypto.randomBytes(24).toString('base64url');
    q('INSERT INTO oidc_codes (code_hash, client_id, user_id, redirect_uri, scope, nonce, challenge, challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha(code), c.client_id, req.user.id, b.redirect_uri, scopes.join(' '), b.nonce ? String(b.nonce).slice(0, 500) : null, b.code_challenge ? String(b.code_challenge).slice(0, 200) : null, method, Date.now() + CODE_TTL);
    audit(req, 'oidc.signin', { target: c.name });
    q(`INSERT INTO oidc_grants (user_id, client_id, scope, granted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, client_id) DO UPDATE SET scope = excluded.scope, granted_at = excluded.granted_at`).run(req.user.id, c.client_id, scopes.join(' '), now());
    q('DELETE FROM oidc_codes WHERE expires_at < ?').run(Date.now());
    res.json({ redirect: redirectWith(b.redirect_uri, { code, state: b.state }) });
  });
  r.post('/deny', (req, res) => {
    const b = req.body || {};
    loadRequest(req, b);
    res.json({ redirect: redirectWith(b.redirect_uri, { error: 'access_denied', state: b.state }) });
  });

  // The company's apps you may use that have a home page, for the launcher on Home.
  r.get('/launcher', (req, res) => {
    res.json(q('SELECT * FROM oidc_clients WHERE org_id = ? AND home_url IS NOT NULL ORDER BY name COLLATE NOCASE').all(req.user.org_id)
      .filter((c) => mayUse(c, req.user)).map((c) => ({ id: c.id, name: c.name, url: c.home_url })));
  });

  // Apps you've let in (and taking that back).
  r.get('/grants', (req, res) => res.json(q(`SELECT g.client_id, g.scope, g.granted_at, c.name FROM oidc_grants g JOIN oidc_clients c ON c.client_id = g.client_id WHERE g.user_id = ? ORDER BY c.name`).all(req.user.id)));
  r.delete('/grants/:clientId', (req, res) => {
    q('DELETE FROM oidc_grants WHERE user_id = ? AND client_id = ?').run(req.user.id, req.params.clientId);
    q('DELETE FROM oidc_tokens WHERE user_id = ? AND client_id = ?').run(req.user.id, req.params.clientId);
    q('DELETE FROM oidc_refresh WHERE user_id = ? AND client_id = ?').run(req.user.id, req.params.clientId);
    res.json({ ok: true });
  });

  // ---- admins: the company's apps ----
  const admin = (req) => { if (!req.user.is_admin) throw new HttpError(403, 'Only administrators manage apps'); };
  const readUris = (list) => {
    const uris = [...new Set((Array.isArray(list) ? list : String(list || '').split(/\s+/)).map((u) => String(u).trim()).filter(Boolean).map(cleanRedirect))];
    if (!uris.length) throw bad('Give the address the app sends people back to (its redirect or callback URL)');
    if (uris.length > 10) throw bad('At most 10 addresses');
    return uris;
  };
  r.get('/apps', (req, res) => { admin(req); res.json(q('SELECT * FROM oidc_clients WHERE org_id = ? ORDER BY name').all(req.user.org_id).map(shapeClient)); });
  r.post('/apps', (req, res) => {
    admin(req);
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!name) throw bad('Give the app a name');
    const uris = readUris(req.body?.redirect_uris);
    if (q('SELECT COUNT(*) AS n FROM oidc_clients WHERE org_id = ?').get(req.user.org_id).n >= 50) throw bad('At most 50 apps');
    const groups = readGroups(req, req.body?.allowed_groups);
    const id = uid(), clientId = `ws-${crypto.randomBytes(9).toString('base64url')}`, secret = crypto.randomBytes(30).toString('base64url');
    q('INSERT INTO oidc_clients (id, org_id, name, client_id, secret_hash, redirect_uris, allowed_groups, home_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.org_id, name, clientId, sha(secret), JSON.stringify(uris), groups.length ? JSON.stringify(groups) : null, readHome(req.body?.home_url), req.user.id, now());
    audit(req, 'oidc.app_added', { target: name, details: { redirect_uris: uris } });
    res.status(201).json({ ...shapeClient(q('SELECT * FROM oidc_clients WHERE id = ?').get(id)), client_secret: secret }); // the secret is shown this once
  });
  const readGroups = (req, list) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw bad('allowed_groups must be a list');
    const ids = [...new Set(list.map(String))];
    for (const id of ids) if (!q('SELECT 1 FROM groups WHERE id = ? AND org_id = ?').get(id, req.user.org_id)) throw bad('Unknown group');
    return ids;
  };
  const readHome = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    let u;
    try { u = new URL(String(v).trim()); } catch { throw bad('The app’s address must be a web address'); }
    if (!/^https?:$/.test(u.protocol)) throw bad('The app’s address must start with https:// or http://');
    return u.toString();
  };
  const ownApp = (req) => { admin(req); const c = q('SELECT * FROM oidc_clients WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id); if (!c) throw notFound('App not found'); return c; };
  r.patch('/apps/:id', (req, res) => {
    const c = ownApp(req);
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 100) || c.name : c.name;
    const uris = req.body?.redirect_uris !== undefined ? readUris(req.body.redirect_uris) : JSON.parse(c.redirect_uris);
    const groups = req.body?.allowed_groups !== undefined ? readGroups(req, req.body.allowed_groups) : (c.allowed_groups ? JSON.parse(c.allowed_groups) : []);
    const home = req.body?.home_url !== undefined ? readHome(req.body.home_url) : c.home_url;
    q('UPDATE oidc_clients SET name = ?, redirect_uris = ?, allowed_groups = ?, home_url = ? WHERE id = ?').run(name, JSON.stringify(uris), groups.length ? JSON.stringify(groups) : null, home, c.id);
    res.json(shapeClient(q('SELECT * FROM oidc_clients WHERE id = ?').get(c.id)));
  });
  r.post('/apps/:id/secret', (req, res) => { // a new secret (the old one stops working)
    const c = ownApp(req);
    const secret = crypto.randomBytes(30).toString('base64url');
    q('UPDATE oidc_clients SET secret_hash = ? WHERE id = ?').run(sha(secret), c.id);
    audit(req, 'oidc.app_secret', { target: c.name });
    res.json({ client_secret: secret });
  });
  r.delete('/apps/:id', (req, res) => {
    const c = ownApp(req);
    for (const t of ['oidc_codes', 'oidc_tokens', 'oidc_refresh', 'oidc_grants']) q(`DELETE FROM ${t} WHERE client_id = ?`).run(c.client_id);
    audit(req, 'oidc.app_removed', { target: c.name });
    q('DELETE FROM oidc_clients WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });
  return r;
}

