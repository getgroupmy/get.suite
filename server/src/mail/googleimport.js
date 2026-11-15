// Importing mail from Gmail and Google Workspace by signing in at Google (OAuth), for accounts where
// app passwords are off (common in Google Workspace). The person is sent to Google's own sign-in page,
// says yes to Workspace reading their mail, and comes back; the usual IMAP import (imap.gmail.com, with
// XOAUTH2) runs with the access Google gives, which isn't kept. Their Google password never comes here.
//
// Each company makes an OAuth client in Google Cloud once (a "Web application", with this server's
// /api/mail/import/google/callback as its redirect URI) and gives its ID and secret in Admin → Company
// settings. The secret is stored on this server and never sent back to the browser.
import crypto from 'node:crypto';
import { q } from '../db.js';
import { bad } from '../util.js';
import { startImport } from './importer.js';

for (const col of ['g_client_id', 'g_client_secret']) {
  if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === col)) q(`ALTER TABLE orgs ADD COLUMN ${col} TEXT`).run();
}
const AUTH = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const IMAP_HOST = () => process.env.GOOGLE_IMAP_HOST || 'imap.gmail.com';
export const GOOGLE_SCOPE = 'openid email https://mail.google.com/';
const STATE_TTL = 10 * 60e3;

/** The company's Google client, or null: { clientId, secret }. */
export function googleAppOf(orgId) {
  const o = q('SELECT g_client_id, g_client_secret FROM orgs WHERE id = ?').get(orgId);
  return o?.g_client_id && o?.g_client_secret ? { clientId: o.g_client_id, secret: o.g_client_secret } : null;
}
/** An admin's settings, checked: Google client IDs end in .apps.googleusercontent.com. */
export function cleanGoogleApp({ client_id: clientId, client_secret: secret }) {
  const id = String(clientId ?? '').trim();
  if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw bad('A Google client ID ends in .apps.googleusercontent.com');
  const s = secret === undefined ? undefined : String(secret).trim();
  if (s !== undefined && s && !/^[\w-]{10,100}$/.test(s)) throw bad('That doesn’t look like a Google client secret');
  return { clientId: id || null, secret: s };
}
export const redirectUri = (base) => `${base.replace(/\/$/, '')}/api/mail/import/google/callback`;

// Sign-ins on their way (by state): { userId, verifier, email, at }.
const states = new Map();
const b64url = (b) => Buffer.from(b).toString('base64url');

/** Where to send the person: Google's sign-in, for this company's client, with PKCE and a one-time state. */
export function googleSignInUrl(user, { email = '', base }) {
  const app = googleAppOf(user.org_id);
  if (!app) throw bad('Your company hasn’t set up importing from Google yet (Admin → Company settings)');
  for (const [k, v] of states) if (Date.now() - v.at > STATE_TTL) states.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  states.set(state, { userId: user.id, verifier, at: Date.now() });
  const u = new URL(AUTH());
  for (const [k, v] of Object.entries({
    client_id: app.clientId, redirect_uri: redirectUri(base), response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'online', prompt: 'consent',
    state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...(email && { login_hint: String(email).trim() }),
  })) u.searchParams.set(k, v);
  return u.toString();
}

/** The address in an ID token Google just gave us (over TLS, straight from Google: its payload is enough here). */
function emailOf(idToken) {
  try { const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url')); return p.email_verified === false ? null : String(p.email || '').toLowerCase() || null; } catch { return null; }
}

/** Google sent the person back: swap the code, then start the import. → the import, or throws (with a message for the person). */
export async function finishGoogleSignIn(user, { code, state, error, base }, { start = startImport } = {}) {
  const s = states.get(String(state || ''));
  states.delete(String(state || ''));
  if (error) throw bad(error === 'access_denied' ? 'You didn’t let Workspace read your Google mail, so nothing was imported' : `Google said: ${String(error).slice(0, 100)}`);
  if (!s || s.userId !== user.id || Date.now() - s.at > STATE_TTL) throw bad('That sign-in link has expired or isn’t yours: start the import again');
  const app = googleAppOf(user.org_id);
  if (!app) throw bad('Your company hasn’t set up importing from Google');
  const r = await fetch(TOKEN(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), client_id: app.clientId, client_secret: app.secret, redirect_uri: redirectUri(base), code_verifier: s.verifier }),
  }).catch((e) => ({ ok: false, json: async () => ({ error_description: e.message }) }));
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw bad(`Google didn’t complete the sign-in: ${String(t.error_description || t.error || 'no access given').slice(0, 200)}`);
  if (!String(t.scope || GOOGLE_SCOPE).includes('https://mail.google.com/')) throw bad('Google didn’t give access to the mail (tick the box for Gmail when asked)');
  const email = emailOf(t.id_token);
  if (!email) throw bad('Google didn’t say which address signed in');
  return start(user, { host: IMAP_HOST(), port: 993, username: email, accessToken: t.access_token });
}
