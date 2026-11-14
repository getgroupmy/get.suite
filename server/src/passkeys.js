// Passkeys people add to their account (Settings → Passkeys), and the short-lived challenges a browser
// signs when one is made or used. See webauthn.js for the checks.
import crypto from 'node:crypto';
import { q } from './db.js';
import { b64url } from './webauthn.js';

q(`CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                -- the credential id (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,           -- SPKI, base64url
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
)`).run();
q('CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id)').run();

export const MAX_PASSKEYS = 20;
export const CHALLENGE_MS = 5 * 60e3;
const MAX_WAITING = 10000;
const waiting = new Map(); // key → { challenge, userId?, at }

/** A fresh challenge, kept under `key` for a few minutes (one use). */
export function newChallenge(key, userId = null, at = Date.now()) {
  for (const [k, v] of waiting) if (at - v.at > CHALLENGE_MS || waiting.size >= MAX_WAITING) waiting.delete(k); else break;
  const challenge = b64url(crypto.randomBytes(32));
  waiting.delete(key);
  waiting.set(key, { challenge, userId, at });
  return challenge;
}
/** The challenge kept under `key` (gone once taken), or null when there's none or it's too old. */
export function takeChallenge(key, at = Date.now()) {
  const w = waiting.get(key);
  waiting.delete(key);
  return w && at - w.at <= CHALLENGE_MS ? w : null;
}

export const passkeysOf = (userId) => q('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId);
export const passkeyById = (id) => q('SELECT * FROM passkeys WHERE id = ?').get(String(id || ''));
