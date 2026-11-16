// Form webhooks: each new or changed response is also sent, as JSON, to a web address the form's owner
// gives (Settings → Send responses to a web address): a CRM, a chat bot, an automation service. Each
// delivery is signed with a secret only the owner sees (X-Workspace-Signature: sha256=<HMAC of the body>),
// so the receiver can check it came from here. Only https addresses on the public internet are used,
// never this server's own network, and redirects aren't followed. A failed delivery is tried twice more
// (after 1 and 5 minutes); the last result is shown in the settings.
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { q } from './db.js';
import { bad } from './util.js';
import { isPrivateAddress, publicLookup } from './mail/unsubscribe.js';

q(`CREATE TABLE IF NOT EXISTS form_webhooks (
  form_id TEXT PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_at INTEGER, last_status INTEGER, last_error TEXT
)`).run();

const RETRIES = [60e3, 5 * 60e3];
// For tests: a local receiver with a self-signed certificate.
let options = { allowPrivate: false, tls: {}, retries: RETRIES };
export function setHookOptions(o) { options = { ...options, ...o }; }

/** A web address to send to, checked: https, a host name or public address, no password in it. */
export function cleanHookUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw bad('That isn’t a web address'); }
  if (u.protocol !== 'https:') throw bad('Use a secure address (https://…)');
  if (u.username || u.password) throw bad('Leave the password out of the address');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!options.allowPrivate && (host === 'localhost' || /\.(local|internal|lan|home)$/i.test(host) || (net.isIP(host) && isPrivateAddress(host)))) throw bad('That address is on a private network');
  if (u.href.length > 2000) throw bad('That address is too long');
  return u.href;
}

/** The form's webhook for its owner (the secret included), or null. */
export function hookOf(formId) {
  const h = q('SELECT * FROM form_webhooks WHERE form_id = ?').get(formId);
  return h ? { url: h.url, secret: h.secret, last_at: h.last_at, last_status: h.last_status, last_error: h.last_error } : null;
}

export function setHook(formId, url) {
  const clean = cleanHookUrl(url);
  const had = q('SELECT secret FROM form_webhooks WHERE form_id = ?').get(formId);
  if (had) q('UPDATE form_webhooks SET url = ?, last_at = NULL, last_status = NULL, last_error = NULL WHERE form_id = ?').run(clean, formId);
  else q('INSERT INTO form_webhooks (form_id, url, secret, created_at) VALUES (?, ?, ?, ?)').run(formId, clean, `whsec_${crypto.randomBytes(24).toString('base64url')}`, Date.now());
  return hookOf(formId);
}
export const removeHook = (formId) => q('DELETE FROM form_webhooks WHERE form_id = ?').run(formId);
/** A new secret (the old one stops being used at once). */
export function newSecret(formId) {
  q('UPDATE form_webhooks SET secret = ? WHERE form_id = ?').run(`whsec_${crypto.randomBytes(24).toString('base64url')}`, formId);
  return hookOf(formId);
}

export const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

/** POST the body; resolves with the status (2xx is delivered), rejects with a reason people can read. */
function post(url, body, secret, event) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST', ...options.tls, lookup: options.allowPrivate ? undefined : publicLookup, timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Workspace-Forms', 'X-Workspace-Event': event, 'X-Workspace-Signature': sign(secret, body) },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('It didn’t answer within 10 seconds')));
    req.on('error', (e) => reject(new Error(e.code === 'EPRIVATE' ? 'That address is on a private network' : e.code === 'ENOTFOUND' ? 'No such server' : e.message)));
    req.end(body);
  });
}

function record(formId, status, error) {
  q('UPDATE form_webhooks SET last_at = ?, last_status = ?, last_error = ? WHERE form_id = ?').run(Date.now(), status ?? null, error ? String(error).slice(0, 300) : null, formId);
}

/** Send one payload now: { ok, status, error } (and the result kept for the settings). */
export async function deliverNow(formId, event, payload) {
  const h = q('SELECT * FROM form_webhooks WHERE form_id = ?').get(formId);
  if (!h) return { ok: false, error: 'No web address is set' };
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), ...payload });
  try {
    const status = await post(h.url, body, h.secret, event);
    const ok = status >= 200 && status < 300;
    record(formId, status, ok ? null : `It answered ${status}`);
    return { ok, status, ...(!ok && { error: `It answered ${status}` }) };
  } catch (e) { record(formId, null, e.message); return { ok: false, error: e.message }; }
}

/** Send in the background, trying again later when it fails. */
export function deliver(formId, event, payload) {
  if (!q('SELECT 1 FROM form_webhooks WHERE form_id = ?').get(formId)) return;
  const attempt = (n) => deliverNow(formId, event, payload).then((r) => {
    if (!r.ok && n < options.retries.length) setTimeout(() => attempt(n + 1), options.retries[n]).unref();
  }).catch((e) => console.error('[forms] webhook:', e.message));
  attempt(0);
}

/** What's sent for a response: the form, who sent it (where the form records it), and each answer by question. */
const asText = (qu, a) => {
  if (a === undefined || a === null || a === '') return null;
  if (qu.type === 'signature') return 'Signed';
  if (qu.type === 'grid' || qu.type === 'checkgrid') return Object.entries(a).map(([row, col]) => `${row}: ${[col].flat().join(', ')}`).join('; ');
  return Array.isArray(a) ? a.map((x) => (x && typeof x === 'object' ? x.name : x)).join(', ') : String(a);
};
export function hookPayload(form, resp) {
  const answers = JSON.parse(resp.answers || '{}');
  const user = resp.user_id ? q('SELECT name, username FROM users WHERE id = ?').get(resp.user_id) : null;
  return {
    form: { id: form.id, title: form.title },
    response: {
      id: resp.id, created_at: new Date(resp.created_at).toISOString(), ...(resp.updated_at && { updated_at: new Date(resp.updated_at).toISOString() }),
      ...(user ? { from: { name: user.name, email: user.username } } : resp.email ? { from: { email: resp.email } } : {}),
      answers: form.questions.filter((qu) => qu.type !== 'section').map((qu) => ({ id: qu.id, question: qu.title, type: qu.type, answer: qu.type === 'signature' ? (answers[qu.id] ? 'signed' : null) : answers[qu.id] ?? null, text: asText(qu, answers[qu.id]) })),
    },
  };
}
