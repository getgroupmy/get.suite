// Signing AI assistants in to the MCP server with OAuth (as claude.ai's and ChatGPT's connectors do):
// they find the way in from /.well-known/oauth-protected-resource and
// /.well-known/oauth-authorization-server, register themselves (dynamic client registration, RFC 7591)
// and send the person to Workspace's own consent page (oidc.js), with PKCE. The access tokens they get
// (nwa_…) act like an API token of the person's, read-only or read-and-write as the person chose, and
// work only at /mcp. Companies allow this with the same setting as API tokens.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { q } from './db.js';
import { now } from './util.js';

q(`CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,   -- JSON
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
)`).run();

export const MCP_SCOPES = ['mcp:read', 'mcp:write'];
const MAX_CLIENTS = 2000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const issuerOf = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

/** A registered assistant, shaped like a company app for oidc.js (kind 'mcp', no company, no secret). */
export function mcpClientBy(clientId) {
  const c = q('SELECT * FROM mcp_clients WHERE client_id = ?').get(String(clientId || ''));
  return c ? { ...c, kind: 'mcp', id: c.client_id, org_id: null, secret_hash: null } : null;
}
/** Whether a company lets its people connect assistants (the API tokens setting). */
export const orgAllowsAssistants = (orgId) => !!q('SELECT allow_api_tokens FROM orgs WHERE id = ?').get(orgId)?.allow_api_tokens;

/** The scopes an assistant gets: read always, write when asked for (or when it names none). */
export function mcpScopesOf(scope) {
  const asked = String(scope || '').split(/\s+/).filter(Boolean);
  const out = ['mcp:read'];
  if (!asked.length || asked.includes('mcp:write')) out.push('mcp:write');
  if (asked.includes('offline_access')) out.push('offline_access');
  return out;
}

/** A return address an assistant may register: https anywhere, or http only on this computer (Claude Code and other local tools). */
export function assistantRedirectOk(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The token row for an assistant's access token (nwa_…), when valid: { id, user_id, scope: 'read'|'write', mcp: true }. */
export function assistantTokenRow(token) {
  const row = q(`SELECT t.*, u.disabled, o.allow_api_tokens, c.client_id AS mcp_client FROM oidc_tokens t JOIN mcp_clients c ON c.client_id = t.client_id
                 JOIN users u ON u.id = t.user_id JOIN orgs o ON o.id = u.org_id WHERE t.token_hash = ?`).get(sha(token));
  if (!row || row.disabled || !row.allow_api_tokens || row.expires_at < Date.now()) return null;
  if (!q('SELECT 1 FROM oidc_grants WHERE user_id = ? AND client_id = ?').get(row.user_id, row.client_id)) return null; // taken back
  q('UPDATE mcp_clients SET last_used_at = ? WHERE client_id = ? AND (last_used_at IS NULL OR last_used_at < ?)').run(now(), row.client_id, now() - 60e3);
  return { id: `mcp:${row.client_id}`, user_id: row.user_id, scope: row.scope.split(' ').includes('mcp:write') ? 'write' : 'read', mcp: true };
}

export function mcpAuthRoutes() {
  const r = Router();
  const resourceMeta = (req, res) => {
    const iss = issuerOf(req);
    res.json({ resource: `${iss}/mcp`, authorization_servers: [iss], scopes_supported: MCP_SCOPES, bearer_methods_supported: ['header'], resource_name: 'Workspace' });
  };
  r.get('/.well-known/oauth-protected-resource', resourceMeta);
  r.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
  const serverMeta = (req, res) => {
    const iss = issuerOf(req);
    res.json({
      issuer: iss, authorization_endpoint: `${iss}/oauth/authorize`, token_endpoint: `${iss}/oauth/token`, registration_endpoint: `${iss}/oauth/register`,
      jwks_uri: `${iss}/oauth/jwks`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: [...MCP_SCOPES, 'offline_access', 'openid', 'profile', 'email'],
    });
  };
  r.get('/.well-known/oauth-authorization-server', serverMeta);
  r.get('/.well-known/oauth-authorization-server/mcp', serverMeta);

  // Dynamic client registration: an assistant says who it is and where to send people back. It's a
  // public client (PKCE, no secret); nothing is allowed until a person says yes on the consent page.
  r.post('/oauth/register', express.json({ limit: '20kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const fail = (error, description) => res.status(400).json({ error, error_description: description });
    const uris = Array.isArray(b.redirect_uris) ? [...new Set(b.redirect_uris.map(String))] : [];
    if (!uris.length || uris.length > 10) return fail('invalid_redirect_uri', 'Give one to ten redirect_uris');
    const badUri = uris.find((u) => !assistantRedirectOk(u));
    if (badUri) return fail('invalid_redirect_uri', `Not allowed: ${badUri} (https, or http on localhost)`);
    if (b.grant_types && !(Array.isArray(b.grant_types) && b.grant_types.every((g) => ['authorization_code', 'refresh_token'].includes(g)))) return fail('invalid_client_metadata', 'Only authorization_code and refresh_token');
    // Forget assistants nobody ever let in, after a day; keep the table bounded.
    q('DELETE FROM mcp_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oidc_grants)').run(now() - 864e5);
    if (q('SELECT COUNT(*) AS n FROM mcp_clients').get().n >= MAX_CLIENTS) return res.status(429).json({ error: 'temporarily_unavailable', error_description: 'Too many registrations; try again later' });
    const name = String(b.client_name || 'AI assistant').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'AI assistant';
    const clientId = `mcp-${crypto.randomBytes(12).toString('base64url')}`;
    q('INSERT INTO mcp_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, JSON.stringify(uris), now());
    res.status(201).json({
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: MCP_SCOPES.join(' '),
    });
  });
  return r;
}
