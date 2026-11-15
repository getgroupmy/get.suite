// Importing mail from Microsoft 365 (and Outlook.com) work accounts, which no longer take passwords over
// IMAP: the person signs in at Microsoft with a code (the "device code" flow), Workspace is given a
// token that may read their mail over IMAP (IMAP.AccessAsUser.All), and the usual import runs with it.
// Their Microsoft password never passes through Workspace, and the token isn't kept after the import.
//
// Each company registers an app at Microsoft once (Entra ID → App registrations: a public client with
// "Allow public client flows" on and the delegated permission IMAP.AccessAsUser.All) and gives its
// client ID (and tenant, or "organizations") in Admin → Company settings.
import { q } from '../db.js';
import { bad } from '../util.js';
import { sendTo } from '../hub.js';
import { startImport } from './importer.js';

if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'ms_client_id')) q('ALTER TABLE orgs ADD COLUMN ms_client_id TEXT').run();
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'ms_tenant')) q('ALTER TABLE orgs ADD COLUMN ms_tenant TEXT').run();

const LOGIN = () => (process.env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
const IMAP_HOST = () => process.env.MS_IMAP_HOST || 'outlook.office365.com';
export const MS_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The company's Microsoft app, or null: { clientId, tenant }. */
export function msAppOf(orgId) {
  const o = q('SELECT ms_client_id, ms_tenant FROM orgs WHERE id = ?').get(orgId);
  return o?.ms_client_id ? { clientId: o.ms_client_id, tenant: o.ms_tenant || 'organizations' } : null;
}
/** An admin's settings, checked: client ID a GUID, tenant a GUID, a domain, or organizations/common. */
export function cleanMsApp({ client_id: clientId, tenant }) {
  const id = String(clientId || '').trim();
  if (id && !GUID.test(id)) throw bad('The Microsoft app (client) ID looks like 00000000-0000-0000-0000-000000000000');
  const t = String(tenant || '').trim().toLowerCase();
  if (t && !GUID.test(t) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) && !['organizations', 'common'].includes(t)) throw bad('The tenant is its ID, its domain (yourcompany.onmicrosoft.com) or "organizations"');
  return { clientId: id || null, tenant: t || null };
}

const form = async (url, fields) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** Sign-ins waiting for the person (by user): { status, user_code, verification_uri, expires_at, email, error } */
const pending = new Map();
export const msStatusOf = (userId) => {
  const p = pending.get(userId);
  if (!p) return { status: 'none' };
  const { device_code: _d, timer: _t, ...shown } = p;
  return shown;
};

/**
 * Start: ask Microsoft for a code for this person to enter at microsoft.com/devicelogin; then wait for
 * them in the background, and start the import once they've signed in. → what to show them.
 */
export async function startMsImport(user, { email }, { start = startImport, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const app = msAppOf(user.org_id);
  if (!app) throw bad('Your company hasn’t set up importing from Microsoft 365 yet (Admin → Company settings)');
  const mailbox = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailbox)) throw bad('Give the address of the Microsoft 365 mailbox');
  const old = pending.get(user.id);
  if (old?.status === 'waiting') old.cancelled = true;
  const r = await form(`${LOGIN()}/${encodeURIComponent(app.tenant)}/oauth2/v2.0/devicecode`, { client_id: app.clientId, scope: MS_SCOPE }).catch((e) => ({ status: 0, body: { error_description: e.message } }));
  if (r.status !== 200 || !r.body.device_code) throw bad(`Microsoft didn’t start the sign-in: ${String(r.body.error_description || r.body.error || r.status).split('\n')[0].slice(0, 200)}`);
  const job = {
    status: 'waiting', email: mailbox, user_code: r.body.user_code, verification_uri: r.body.verification_uri || 'https://microsoft.com/devicelogin',
    expires_at: Date.now() + (Number(r.body.expires_in) || 900) * 1000, device_code: r.body.device_code,
  };
  pending.set(user.id, job);
  const tell = () => sendTo([user.id], { type: 'ms-import', ms: msStatusOf(user.id) });
  // Wait for the person, asking Microsoft every few seconds (as long as it says to).
  (async () => {
    let wait = Math.max(1, Number(r.body.interval) || 5) * 1000;
    while (!job.cancelled && Date.now() < job.expires_at) {
      await sleep(wait);
      if (job.cancelled) return;
      const t = await form(`${LOGIN()}/${encodeURIComponent(app.tenant)}/oauth2/v2.0/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: app.clientId, device_code: job.device_code })
        .catch((e) => ({ status: 0, body: { error: 'network', error_description: e.message } }));
      if (t.status === 200 && t.body.access_token) {
        job.status = 'signed-in'; delete job.device_code; tell();
        try { await start(user, { host: IMAP_HOST(), port: 993, username: job.email, accessToken: t.body.access_token }); job.status = 'importing'; }
        catch (e) { job.status = 'error'; job.error = e.message; }
        tell();
        return;
      }
      const err = t.body.error;
      if (err === 'authorization_pending' || err === 'network') continue;
      if (err === 'slow_down') { wait += 5000; continue; }
      job.status = err === 'authorization_declined' ? 'declined' : err === 'expired_token' ? 'expired' : 'error';
      job.error = String(t.body.error_description || err || 'Sign-in failed').split('\n')[0].slice(0, 200);
      delete job.device_code; tell();
      return;
    }
    if (!job.cancelled && job.status === 'waiting') { job.status = 'expired'; delete job.device_code; tell(); }
  })();
  tell();
  return msStatusOf(user.id);
}

export function cancelMsImport(userId) {
  const p = pending.get(userId);
  if (p) { p.cancelled = true; pending.delete(userId); }
}
