// Passkeys in the browser: the server's options (JSON, binary as base64url) into what
// navigator.credentials wants, and the browser's answer back into JSON.

export const toBytes = (s) => {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const toB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Options for navigator.credentials.create, from the server's JSON. */
export function creationOptions(o) {
  return { ...o, challenge: toBytes(o.challenge), user: { ...o.user, id: toBytes(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })) };
}
/** Options for navigator.credentials.get, from the server's JSON. */
export function requestOptions(o) {
  return { ...o, challenge: toBytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })) };
}
/** The browser's answer (a PublicKeyCredential) as JSON for the server. */
export function credentialJson(c) {
  const r = c.response;
  const response = { clientDataJSON: toB64url(r.clientDataJSON) };
  if (r.attestationObject) response.attestationObject = toB64url(r.attestationObject);
  if (r.authenticatorData) response.authenticatorData = toB64url(r.authenticatorData);
  if (r.signature) response.signature = toB64url(r.signature);
  if (r.userHandle) response.userHandle = toB64url(r.userHandle);
  return { id: c.id, type: c.type, response };
}
/** Can this browser use passkeys at all? */
export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create;
/** Why a passkey didn't work, in words (the browser's own errors are terse). */
export function passkeyError(e) {
  if (e?.name === 'NotAllowedError') return 'No passkey was used (it was cancelled or timed out)';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for your account';
  return e?.message || 'The passkey didn’t work';
}
