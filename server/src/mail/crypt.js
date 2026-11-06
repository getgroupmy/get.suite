// SHA512-CRYPT ("$6$", Ulrich Drepper's SHA-crypt) — the password format Dovecot verifies.
// Spec: https://www.akkadia.org/drepper/SHA-crypt.txt
import crypto from 'node:crypto';

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

const sha = () => crypto.createHash('sha512');

function b64(b2, b1, b0, n) {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let out = '';
  while (n-- > 0) { out += ITOA64[w & 0x3f]; w >>= 6; }
  return out;
}

function repeatTo(block, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += block.length) block.copy(out, i, 0, Math.min(block.length, len - i));
  return out;
}

export function sha512crypt(password, salt = crypto.randomBytes(12).toString('base64').replace(/[+=]/g, '.').slice(0, 16), rounds = 5000) {
  const P = Buffer.from(String(password), 'utf8');
  const S = Buffer.from(String(salt).slice(0, 16), 'utf8');
  rounds = Math.min(999999999, Math.max(1000, rounds));

  const B = sha().update(P).update(S).update(P).digest();
  const a = sha().update(P).update(S);
  let i;
  for (i = P.length; i > 64; i -= 64) a.update(B);
  a.update(B.subarray(0, i));
  for (i = P.length; i > 0; i >>= 1) a.update(i & 1 ? B : P);
  let C = a.digest();

  const dp = sha();
  for (i = 0; i < P.length; i++) dp.update(P);
  const Pseq = repeatTo(dp.digest(), P.length);

  const ds = sha();
  for (i = 0; i < 16 + C[0]; i++) ds.update(S);
  const Sseq = repeatTo(ds.digest(), S.length);

  for (let r = 0; r < rounds; r++) {
    const h = sha();
    h.update(r & 1 ? Pseq : C);
    if (r % 3) h.update(Sseq);
    if (r % 7) h.update(Pseq);
    h.update(r & 1 ? C : Pseq);
    C = h.digest();
  }

  let out = '';
  for (const [x, y, z] of ORDER) out += b64(C[x], C[y], C[z], 4);
  out += b64(0, 0, C[63], 2);
  return `$6$${rounds !== 5000 ? `rounds=${rounds}$` : ''}${S.toString('utf8')}$${out}`;
}

/** Dovecot passwd-file value, e.g. {SHA512-CRYPT}$6$rounds=20000$salt$hash */
export function dovecotHash(password, rounds = 20000) {
  return `{SHA512-CRYPT}${sha512crypt(password, undefined, rounds)}`;
}

/** Check a password against a Dovecot {SHA512-CRYPT} value (constant time). */
export function verifyDovecotHash(password, stored) {
  const m = /^\{SHA512-CRYPT\}\$6\$(?:rounds=(\d+)\$)?([^$]{0,16})\$([./0-9A-Za-z]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const again = sha512crypt(password, m[2], m[1] ? Number(m[1]) : 5000);
  const a = Buffer.from(`{SHA512-CRYPT}${again}`), b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
