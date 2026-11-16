// Single sign-on: people sign in to Workspace with their company's identity provider (Microsoft Entra ID,
// Google, Okta, Keycloak… anything that speaks OpenID Connect), set up per company in Admin → Company
// settings. The authorization-code flow with PKCE, a one-time state and a nonce: the provider sends the
// person back with a code, which the server swaps for an ID token whose signature is checked against the
// provider's published keys (RS256 or ES256), with its issuer, audience, expiry and nonce. The email in it
// must be a Workspace account in that company. Routes: routes/auth.js (/api/auth/sso/…).
import crypto from 'node:crypto';
import { q } from './db.js';
import { bad } from './util.js';

for (const col of ['sso_issuer TEXT', 'sso_client_id TEXT', 'sso_secret TEXT', 'sso_label TEXT', 'sso_required INTEGER NOT NULL DEFAULT 0', 'sso_create INTEGER NOT NULL DEFAULT 0']) {
  if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === col.split(' ')[0])) q(`ALTER TABLE orgs ADD COLUMN ${col}`).run();
}
q(`CREATE TABLE IF NOT EXISTS sso_states (
  state TEXT PRIMARY KEY, org_id TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, created_at INTEGER NOT NULL
)`).run();
if (!q('PRAGMA table_info(sso_states)').all().some((c) => c.name === 'next_path')) q('ALTER TABLE sso_states ADD COLUMN next_path TEXT').run(); // a page here to come back to

const STATE_MS = 10 * 60e3;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An issuer address as kept: https (http only for this machine, for testing), no trailing slash. */
export function cleanIssuer(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw bad('The identity provider’s address isn’t a web address'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw bad('The identity provider’s address must start with https://');
  return s;
}

/** The company's single sign-on, when it's set up: { issuer, clientId, secret, label }. */
export function ssoOf(orgId) {
  const o = q('SELECT sso_issuer, sso_client_id, sso_secret, sso_label FROM orgs WHERE id = ?').get(orgId);
  return o?.sso_issuer && o.sso_client_id && o.sso_secret ? { issuer: o.sso_issuer, clientId: o.sso_client_id, secret: o.sso_secret, label: o.sso_label || 'your company account' } : null;
}

/** The company whose domain an address is on (where its single sign-on would be). */
export function orgForEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1];
  return domain ? q('SELECT org_id FROM domains WHERE name = ?').get(domain)?.org_id || null : null;
}

// The provider's own description and keys, fetched as needed and kept for ten minutes.
const cache = new Map();
async function fetchJson(url, fetcher) {
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.value;
  const r = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`The identity provider answered ${r.status} for ${new URL(url).pathname}`);
  const value = await r.json();
  cache.set(url, { value, until: Date.now() + 10 * 60e3 });
  return value;
}
export const forgetProviders = () => cache.clear();

/** The provider's OpenID configuration, checked to be its own (the issuer it says matches the one set up). */
export async function discover(issuer, fetcher = fetch) {
  const d = await fetchJson(`${issuer}/.well-known/openid-configuration`, fetcher);
  if (String(d.issuer || '').replace(/\/+$/, '') !== issuer) throw new Error('The identity provider describes itself as another issuer');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!d[k]) throw new Error(`The identity provider has no ${k}`);
  return d;
}

/** A new sign-in: the state, nonce and PKCE pair kept for when the provider sends the person back. */
export function newAttempt(orgId, at = Date.now(), next = null) {
  q('DELETE FROM sso_states WHERE created_at < ?').run(at - STATE_MS);
  const state = b64url(crypto.randomBytes(24)), nonce = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(48));
  q('INSERT INTO sso_states (state, org_id, nonce, verifier, created_at, next_path) VALUES (?, ?, ?, ?, ?, ?)').run(state, orgId, nonce, verifier, at, next);
  return { state, nonce, verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/** The attempt a state belongs to, once (it's used up), and only within ten minutes. */
export function takeAttempt(state, at = Date.now()) {
  const row = q('SELECT * FROM sso_states WHERE state = ?').get(String(state || ''));
  if (!row) return null;
  q('DELETE FROM sso_states WHERE state = ?').run(row.state);
  return at - row.created_at <= STATE_MS ? row : null;
}

/**
 * The claims of an ID token, once its signature (a key from `jwks`) and contents check out; throws otherwise.
 * RS256 and ES256 only (never "none" or a shared-secret algorithm).
 */
export function verifyIdToken(token, { issuer, clientId, nonce, jwks, at = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Not an ID token');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new Error('An unreadable ID token'); }
  const alg = { RS256: 'RSA-SHA256', ES256: 'SHA256' }[header.alg];
  if (!alg) throw new Error(`ID tokens signed with ${header.alg} aren’t accepted`);
  const keys = (jwks?.keys || []).filter((k) => (!header.kid || k.kid === header.kid) && (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC') && (!k.use || k.use === 'sig'));
  if (!keys.length) throw new Error('The identity provider has no key for this ID token');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = Buffer.from(parts[2], 'base64url');
  const ok = keys.some((k) => {
    try { return crypto.verify(alg, data, header.alg === 'ES256' ? { key: crypto.createPublicKey({ key: k, format: 'jwk' }), dsaEncoding: 'ieee-p1363' } : crypto.createPublicKey({ key: k, format: 'jwk' }), sig); } catch { return false; }
  });
  if (!ok) throw new Error('The ID token’s signature doesn’t check out');
  if (String(claims.iss || '').replace(/\/+$/, '') !== issuer) throw new Error('The ID token is from another issuer');
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(clientId)) throw new Error('The ID token is for another app');
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new Error('The ID token is for another app');
  const now = Math.floor(at / 1000);
  if (!(Number(claims.exp) > now - 60)) throw new Error('The ID token has expired');
  if (claims.iat && Number(claims.iat) > now + 300) throw new Error('The ID token is from the future');
  if (claims.nonce !== nonce) throw new Error('The ID token isn’t for this sign-in');
  return claims;
}

/** The email address a provider says the person has (Microsoft sometimes only gives preferred_username / upn). */
export function emailOf(claims) {
  if (claims.email && claims.email_verified !== false) return String(claims.email).toLowerCase();
  for (const k of ['preferred_username', 'upn']) if (/^[^\s@]+@[^\s@]+$/.test(String(claims[k] || ''))) return String(claims[k]).toLowerCase();
  return null;
}

/**
 * When the company requires single sign-on: the provider's name, for someone who must sign in that way
 * (everyone but admins, who keep their password in case the provider is down); else null.
 */
export function ssoRequiredFor(userId) {
  const u = q('SELECT u.org_id, u.is_admin, u.is_super, o.sso_required FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ?').get(userId);
  if (!u || !u.sso_required || u.is_admin || u.is_super) return null;
  return ssoOf(u.org_id)?.label || null;
}
export const ssoRequiredMessage = (label) => `Your company signs in with ${label}: use “Sign in with ${label}”.`;

/** A new person's name from the provider: name, else given and family names, else the address before @. */
export function nameOf(claims, email) {
  const n = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').replace(/\s+/g, ' ').trim();
  return (n || email.split('@')[0]).slice(0, 100);
}
