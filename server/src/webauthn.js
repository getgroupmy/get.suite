// Passkeys (WebAuthn), checked with Node's own crypto: what a browser sends when a passkey is made
// (registration) and when it's used to sign in (assertion). Attestation is not asked for ("none"), so a
// new passkey's public key is taken as given; what matters is that every sign-in after is signed by it.
import crypto from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** Decode one CBOR item (RFC 8949: the subset WebAuthn uses) from buf at offset: { value, end }. */
export function cborDecode(buf, offset = 0) {
  let p = offset;
  const need = (n) => { if (p + n > buf.length) throw new Error('CBOR ends too soon'); };
  const readLen = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('CBOR: lengths of unknown size are not taken');
    need(size);
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + buf[p + i];
    p += size;
    return n;
  };
  const item = (depth) => {
    if (depth > 16) throw new Error('CBOR nested too deeply');
    need(1);
    const first = buf[p++];
    const major = first >> 5, info = first & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); need(n); const v = buf.subarray(p, p + n); p += n; return Buffer.from(v); }
      case 3: { const n = readLen(info); need(n); const v = buf.subarray(p, p + n).toString('utf8'); p += n; return v; }
      case 4: { const n = readLen(info); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('CBOR: that simple value is not taken');
      default: throw new Error('CBOR: tags are not taken');
    }
  };
  const value = item(0);
  return { value, end: p };
}

const ALGS = { [-7]: 'ES256', [-257]: 'RS256', [-8]: 'EdDSA' };
export const ALLOWED_ALGS = [-7, -257, -8];

/** A COSE public key (a CBOR map) as a Node KeyObject, with its algorithm. */
export function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (!ALGS[alg]) throw new Error('That kind of passkey is not supported');
  let jwk;
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) throw new Error('Only P-256 keys are supported');
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) };
  } else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) };
  else if (kty === 1 && alg === -8) {
    if (cose.get(-1) !== 6) throw new Error('Only Ed25519 keys are supported');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(cose.get(-2)) };
  } else throw new Error('That kind of passkey is not supported');
  return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
}

/** authenticatorData: rpIdHash, flags, signCount, and (when made) the credential id and public key. */
export function parseAuthData(data) {
  if (data.length < 37) throw new Error('The passkey’s answer is too short');
  const flags = data[32];
  const out = { rpIdHash: data.subarray(0, 32), up: !!(flags & 1), uv: !!(flags & 4), signCount: data.readUInt32BE(33) };
  if (flags & 64) { // attested credential data
    if (data.length < 55) throw new Error('The passkey’s answer is too short');
    const len = data.readUInt16BE(53);
    out.credentialId = data.subarray(55, 55 + len);
    if (out.credentialId.length !== len) throw new Error('The passkey’s answer is too short');
    const { value } = cborDecode(data, 55 + len);
    out.cose = value;
  }
  return out;
}

function checkClient(clientDataJSON, { type, challenge, origin }) {
  let c;
  try { c = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')); } catch { throw new Error('The browser’s answer can’t be read'); }
  if (c.type !== type) throw new Error('That isn’t the answer asked for');
  if (!challenge || c.challenge !== challenge) throw new Error('That passkey answer is out of date. Try again.');
  if (c.origin !== origin) throw new Error('That passkey answer came from another site');
  if (c.crossOrigin) throw new Error('That passkey answer came from another site');
}

/**
 * A new passkey: the browser's answer to navigator.credentials.create. Returns { id, publicKey (SPKI,
 * base64url), alg, signCount, uv }, or throws with what's wrong.
 */
export function verifyRegistration({ clientDataJSON, attestationObject }, { challenge, origin, rpId }) {
  checkClient(fromB64url(clientDataJSON), { type: 'webauthn.create', challenge, origin });
  const att = cborDecode(fromB64url(attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('The passkey’s answer can’t be read');
  const auth = parseAuthData(att.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('That passkey is for another site');
  if (!auth.up) throw new Error('The passkey wasn’t confirmed by you');
  if (!auth.credentialId || !(auth.cose instanceof Map)) throw new Error('The passkey’s answer has no key in it');
  const { key, alg } = coseToKey(auth.cose);
  return { id: b64url(auth.credentialId), publicKey: b64url(key.export({ type: 'spki', format: 'der' })), alg, signCount: auth.signCount, uv: auth.uv };
}

/**
 * A sign-in with a passkey: the browser's answer to navigator.credentials.get, checked against the
 * stored passkey { publicKey, alg, signCount }. Returns { signCount, uv }, or throws.
 */
export function verifyAssertion({ clientDataJSON, authenticatorData, signature }, stored, { challenge, origin, rpId, requireUv = true }) {
  const client = fromB64url(clientDataJSON);
  checkClient(client, { type: 'webauthn.get', challenge, origin });
  const data = fromB64url(authenticatorData);
  const auth = parseAuthData(data);
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('That passkey is for another site');
  if (!auth.up) throw new Error('The passkey wasn’t confirmed by you');
  if (requireUv && !auth.uv) throw new Error('The passkey needs your fingerprint, face or PIN');
  const key = crypto.createPublicKey({ key: fromB64url(stored.publicKey), format: 'der', type: 'spki' });
  const signed = Buffer.concat([data, sha256(client)]);
  const ok = crypto.verify(stored.alg === -8 ? null : 'sha256', signed, key, fromB64url(signature));
  if (!ok) throw new Error('That passkey’s signature is not right');
  // A counter that doesn't go up (when it's counting at all) means the passkey may have been copied.
  if ((auth.signCount || stored.signCount) && auth.signCount <= stored.signCount) throw new Error('That passkey may have been copied: remove it and add it again');
  return { signCount: auth.signCount, uv: auth.uv };
}
