// A pretend authenticator for tests: makes passkeys and signs in with them as a browser would.
import crypto from 'node:crypto';
import { b64url } from '../../src/webauthn.js';

// A tiny CBOR encoder, enough to play the authenticator.
export function enc(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  throw new Error('no');
}
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();

/** A pretend authenticator with one ES256 (or Ed25519) key. */
export function authenticator(kind = 'ec', { origin: ORIGIN = 'https://ws.example.com', rp: RP = 'ws.example.com', userHandle = null } = {}) {
  const { privateKey, publicKey } = kind === 'ed' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = kind === 'ed' ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const credId = crypto.randomBytes(16);
  let count = 0;
  const authData = ({ rp = RP, flags = 0x05, attested = false, counter } = {}) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter ?? count);
    const parts = [sha256(rp), Buffer.from([flags | (attested ? 0x40 : 0)]), c];
    if (attested) { const l = Buffer.alloc(2); l.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), l, credId, enc(cose)); }
    return Buffer.concat(parts);
  };
  const client = (type, challenge, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credId, id: b64url(credId),
    create(challenge, opts = {}) {
      return { clientDataJSON: b64url(client('webauthn.create', challenge, opts.origin)), attestationObject: b64url(enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData({ ...opts, attested: true })]]))) };
    },
    get(challenge, opts = {}) {
      if (opts.counter === undefined) count += 1;
      const data = authData(opts);
      const cd = client('webauthn.get', challenge, opts.origin);
      const sig = crypto.sign(kind === 'ed' ? null : 'sha256', Buffer.concat([data, sha256(cd)]), privateKey);
      return { clientDataJSON: b64url(cd), authenticatorData: b64url(data), signature: b64url(opts.badSig ? Buffer.alloc(sig.length, 1) : sig), ...(userHandle && { userHandle }) };
    },
  };
}

