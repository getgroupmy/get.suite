// Time-based one-time codes (RFC 6238, as used by Google Authenticator, Microsoft Authenticator,
// 1Password, ...): HMAC-SHA1 over a 30-second counter, 6 digits. Plus one-time recovery codes.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not a base32 key');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code for one 30-second step (RFC 4226 dynamic truncation). */
export function codeAt(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

/**
 * Check a code, allowing one step of clock drift either way. Returns the step it matched, or null.
 * A step at or before lastStep is refused, so a code can't be used twice.
 */
export function verifyCode(secret, code, { lastStep = -1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepAt(now);
  for (const step of [s - 1, s, s + 1]) {
    if (step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

/** otpauth:// link that authenticator apps read from the QR code. */
export function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---- recovery codes: 10 one-time codes like "k7m2-9xqp", stored only as hashes ----
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i
export const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex');
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const chars = Array.from(crypto.randomBytes(8), (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}
