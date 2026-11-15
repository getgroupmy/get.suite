// The MCP server (POST /mcp) against a real Workspace server, with API tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mcp-'));
process.env.DATA_DIR = dir;
process.env.PUBLIC_URL = 'https://work.acme.com';
let server, base;
before(async () => {
  const { createApp } = await import('../src/app.js');
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const rpc = async (token, method, params, id = 1, extra = {}) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }), ...extra }, body: JSON.stringify({ jsonrpc: '2.0', ...(id !== null && { id }), method, ...(params && { params }) }) });
  return { status: res.status, body: res.status === 202 ? null : await res.json().catch(() => null), headers: res.headers };
};
const call = async (token, name, args) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
};

let owner, rw, ro;
test('set up: a company, API tokens on, a read-write and a read-only token', async () => {
  owner = client();
  assert.equal((await owner('POST', '/api/auth/setup', { org_name: 'Acme', domain: 'acme.com', name: 'Olivia Owner', local: 'olivia', password: 'password123' })).status, 200);
  await owner('PATCH', '/api/orgs/current', { allow_api_tokens: true });
  rw = (await owner('POST', '/api/tokens', { name: 'Claude', scope: 'write', days: 30 })).body.token;
  ro = (await owner('POST', '/api/tokens', { name: 'ChatGPT', scope: 'read', days: 30 })).body.token;
  assert.ok(rw && ro);
});

test('the handshake: initialize, the initialized notification, ping, tools/list', async () => {
  const init = await rpc(rw, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'workspace');
  assert.ok(init.body.result.capabilities.tools);
  assert.equal((await rpc(rw, 'initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion, '2025-06-18', 'our latest for one we don’t know');
  assert.equal((await rpc(rw, 'notifications/initialized', undefined, null)).status, 202);
  assert.deepEqual((await rpc(rw, 'ping')).body.result, {});
  const tools = (await rpc(rw, 'tools/list')).body.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['search', 'fetch', 'list_events', 'create_event', 'list_tasks', 'create_task', 'complete_task', 'list_mail', 'draft_email', 'create_note', 'create_document']);
  assert.equal(tools.find((t) => t.name === 'search').annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'create_event').annotations.readOnlyHint, false);
  assert.equal((await rpc(rw, 'nonsense/method')).body.error.code, -32601);
  assert.equal((await rpc(rw, 'tools/call', { name: 'nope', arguments: {} })).body.error.code, -32602);
});

test('only with a valid token; a browser cookie isn’t enough', async () => {
  const none = await rpc(null, 'tools/list');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await rpc('nwt_notarealtoken', 'tools/list')).status, 401);
  const cookieOnly = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'nw_sid=x' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(cookieOnly.status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${rw}` } })).status, 405, 'no stream to open');
});

test('make a document, a note, a task and an event; search finds them and fetch reads them', async () => {
  const doc = (await call(rw, 'create_document', { name: 'Pelican launch plan', text: '# Goals\nShip the pelican feature by March.\nThen celebrate.' })).structuredContent;
  assert.match(doc.id, /^file:/);
  assert.match(doc.url, /^https:\/\/work\.acme\.com\/docs\//);
  const note = (await call(rw, 'create_note', { title: 'Pelican shopping', items: ['Fish', 'Bucket'] })).structuredContent;
  assert.match(note.id, /^note:/);
  const task = (await call(rw, 'create_task', { title: 'Book the pelican venue', due: '2026-12-01', notes: 'Riverside' })).structuredContent;
  assert.equal(task.list, 'My tasks');
  const start = Date.UTC(2026, 11, 2, 9);
  const ev = (await call(rw, 'create_event', { title: 'Pelican review', start: new Date(start).toISOString(), end: new Date(start + 36e5).toISOString(), location: 'Room 2' })).structuredContent;
  assert.equal(ev.start, new Date(start).toISOString());

  const found = (await call(rw, 'search', { query: 'pelican' })).structuredContent.results;
  const ids = found.map((r) => r.id.split(':')[0]);
  for (const k of ['file', 'task', 'note', 'event']) assert.ok(ids.includes(k), `${k} in ${JSON.stringify(found)}`);
  const text = JSON.parse((await call(rw, 'search', { query: 'pelican' })).content[0].text);
  assert.deepEqual(Object.keys(text), ['results'], 'the text is the same JSON (what ChatGPT reads)');

  const got = (await call(rw, 'fetch', { id: doc.id })).structuredContent;
  assert.equal(got.title, 'Pelican launch plan');
  assert.match(got.text, /Goals[\s\S]*Ship the pelican feature by March\./);
  assert.match((await call(rw, 'fetch', { id: task.id })).structuredContent.text, /To do: Book the pelican venue\nDue: 2026-12-01[\s\S]*Notes: Riverside/);
  assert.equal((await call(rw, 'fetch', { id: note.id })).structuredContent.text, '[ ] Fish\n[ ] Bucket');
  assert.match((await call(rw, 'fetch', { id: ev.id })).structuredContent.text, /Pelican review\nWhen: 2026-12-02T09:00:00\.000Z.*\nWhere: Room 2/);
  const bad = await call(rw, 'fetch', { id: 'weird:1' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /isn’t one search gave/);
});

test('list and tick off tasks; list events (repeating ones once per time)', async () => {
  const lists = (await call(rw, 'list_tasks', {})).structuredContent.lists;
  const t = lists[0].tasks.find((x) => x.title === 'Book the pelican venue');
  assert.ok(t);
  assert.equal((await call(rw, 'complete_task', { id: t.id })).structuredContent.done, true);
  assert.equal((await call(rw, 'list_tasks', { list: 'My tasks' })).structuredContent.lists[0].tasks.some((x) => x.id === t.id), false, 'done ones left out');
  assert.equal((await call(rw, 'list_tasks', { list: 'My tasks', include_done: true })).structuredContent.lists[0].tasks.find((x) => x.id === t.id).done, true);
  assert.equal((await call(rw, 'list_tasks', { list: 'Nope' })).isError, true);
  const start = Date.UTC(2026, 11, 7, 8);
  await owner('POST', '/api/events', { title: 'Standup', start, end: start + 9e5, rrule: { freq: 'daily', count: 5 } });
  const evs = (await call(rw, 'list_events', { from: '2026-12-07T00:00:00Z', to: '2026-12-10T00:00:00Z' })).structuredContent.events;
  assert.deepEqual(evs.map((e) => [e.title, e.start]), [['Standup', '2026-12-07T08:00:00.000Z'], ['Standup', '2026-12-08T08:00:00.000Z'], ['Standup', '2026-12-09T08:00:00.000Z']]);
  assert.equal((await call(rw, 'list_events', { from: 'tomorrow' })).isError, true);
  assert.equal((await call(rw, 'create_event', { title: 'x', start: '2026-12-01T10:00:00Z', end: '2026-12-01T09:00:00Z' })).isError, true);
});

test('a read-only token reads but can’t change anything', async () => {
  assert.ok((await call(ro, 'search', { query: 'pelican' })).structuredContent.results.length > 0);
  const made = await call(ro, 'create_note', { title: 'Nope', text: 'x' });
  assert.equal(made.isError, true);
  assert.match(made.content[0].text, /read-only/);
});

test('without mail on the server, mail tools say so (search still works)', async () => {
  const r = await call(rw, 'list_mail', {});
  assert.equal(r.isError, true);
  const d = await call(rw, 'draft_email', { to: 'kim@example.com', subject: 'Hi', body: 'Hello' });
  assert.equal(d.isError, true);
});

test('company network rules apply to the assistant’s calls too', async () => {
  assert.equal((await owner('POST', '/api/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).status, 201);
  const kim = client();
  assert.equal((await kim('POST', '/api/auth/login', { username: 'kim@acme.com', password: 'password123' })).status, 200);
  const kt = (await kim('POST', '/api/tokens', { name: 'Claude', scope: 'write', days: 30 })).body.token;
  await owner('PATCH', '/api/orgs/current', { allowed_nets: '10.9.9.0/24' });
  assert.equal((await rpc(kt, 'tools/call', { name: 'search', arguments: { query: 'x' } })).status, 403, 'refused: this test runs from 127.0.0.1, outside 10.9.9.0/24');
  await owner('PATCH', '/api/orgs/current', { allowed_nets: '127.0.0.1/32' });
  const ok = await call(kt, 'create_note', { title: 'From the office', text: 'x' });
  assert.equal(ok.isError, false, JSON.stringify(ok));
  // Forging the header that marks the server's own calls changes nothing.
  await owner('PATCH', '/api/orgs/current', { allowed_nets: '10.9.9.0/24' });
  assert.equal((await rpc(kt, 'tools/list', undefined, 1, { 'x-workspace-inner': 'guess', 'x-workspace-ip': '10.9.9.1' })).status, 403);
  await owner('PATCH', '/api/orgs/current', { allowed_nets: '' });
});

test('OAuth for assistants (claude.ai, ChatGPT): discovery, registration, consent with PKCE, tokens that work only at /mcp, refresh, disconnect', async () => {
  const crypto = await import('node:crypto');
  // 1. /mcp says where to find out how to sign in.
  const first = await rpc(null, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(first.status, 401);
  const meta = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate'))[1];
  assert.equal(meta, 'https://work.acme.com/.well-known/oauth-protected-resource/mcp');
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual([pr.resource, pr.authorization_servers], ['https://work.acme.com/mcp', ['https://work.acme.com']]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.registration_endpoint, 'https://work.acme.com/oauth/register');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  // 2. It registers itself.
  const reg = async (body) => { const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await reg({ client_name: 'Evil', redirect_uris: ['http://evil.example.com/cb'] })).status, 400, 'plain http only on this computer');
  assert.equal((await reg({ client_name: 'x', redirect_uris: [] })).status, 400);
  assert.equal((await reg({ client_name: 'Local tool', redirect_uris: ['http://localhost:33418/callback'] })).status, 201, 'Claude Code and other local tools');
  const r = await reg({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const clientId = r.body.client_id;
  assert.match(clientId, /^mcp-/);
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  // 3. The person is sent to sign in, with PKCE.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authz = (extra) => fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 's1', scope: 'mcp:read mcp:write', resource: 'https://work.acme.com/mcp', ...extra })}`, { redirect: 'manual' });
  const noPkce = await authz({});
  assert.match(noPkce.headers.get('location'), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request/);
  const go = await authz({ code_challenge: challenge, code_challenge_method: 'S256' });
  assert.match(go.headers.get('location'), /^\/oauth\/consent\?/);
  const params = Object.fromEntries(new URL(go.headers.get('location'), base).searchParams);
  const info = (await owner('GET', `/api/oauth/request?${new URLSearchParams(params)}`)).body;
  assert.deepEqual([info.app, info.assistant, info.granted, info.host], ['Claude', true, false, 'claude.ai']);
  // 4. Allowed to read only.
  const ok = (await owner('POST', '/api/oauth/approve', { ...params, access: 'read' })).body;
  const back = new URL(ok.redirect);
  assert.equal(back.searchParams.get('state'), 's1');
  const code = back.searchParams.get('code');
  const token = async (body) => { const x = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }); return { status: x.status, body: await x.json() }; };
  assert.equal((await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: 'wrong' })).status, 400, 'the verifier must match (and the code is now used up)');
  const again = await authz({ code_challenge: challenge, code_challenge_method: 'S256' });
  const params2 = Object.fromEntries(new URL(again.headers.get('location'), base).searchParams);
  const code2 = new URL((await owner('POST', '/api/oauth/approve', { ...params2, access: 'read' })).body.redirect).searchParams.get('code');
  const t = await token({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.access_token, /^nwa_/);
  assert.ok(t.body.refresh_token, 'assistants stay connected');
  assert.equal(t.body.id_token, undefined);
  assert.equal(t.body.scope, 'mcp:read');
  // 5. The token works at /mcp, read only, and nowhere else.
  const at = t.body.access_token;
  assert.ok((await call(at, 'search', { query: 'pelican' })).structuredContent.results.length > 0);
  const write = await call(at, 'create_note', { title: 'x', text: 'y' });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /read-only/);
  const direct = await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${at}` } });
  assert.equal(direct.status, 403);
  assert.match((await direct.json()).error, /MCP server/);
  // 6. Settings lists it; refresh gives a new pair (the old refresh token is spent).
  const grants = (await owner('GET', '/api/oauth/grants')).body;
  const g = grants.find((x) => x.client_id === clientId);
  assert.deepEqual([g.name, g.assistant, g.access], ['Claude', true, 'read']);
  const fresh = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId });
  assert.equal(fresh.status, 200);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId })).status, 400);
  // 7. Allowing changes, next time.
  const p3 = Object.fromEntries(new URL((await authz({ code_challenge: challenge, code_challenge_method: 'S256' })).headers.get('location'), base).searchParams);
  assert.equal((await owner('GET', `/api/oauth/request?${new URLSearchParams(p3)}`)).body.granted, false, 'asks again to give more');
  const code3 = new URL((await owner('POST', '/api/oauth/approve', { ...p3, access: 'write' })).body.redirect).searchParams.get('code');
  const rw2 = (await token({ grant_type: 'authorization_code', code: code3, redirect_uri: redirect, client_id: clientId, code_verifier: verifier })).body.access_token;
  assert.equal((await call(rw2, 'create_note', { title: 'From claude.ai', text: 'hello' })).isError, false);
  // 8. Disconnecting stops it at once.
  await owner('DELETE', `/api/oauth/grants/${clientId}`);
  const gone = await rpc(rw2, 'tools/list');
  assert.equal(gone.status, 401);
  assert.match(gone.headers.get('www-authenticate'), /invalid_token/);
  // 9. A company that has turned API tokens off doesn't let assistants in.
  await owner('PATCH', '/api/orgs/current', { allow_api_tokens: false });
  const p4 = Object.fromEntries(new URL((await authz({ code_challenge: challenge, code_challenge_method: 'S256' })).headers.get('location'), base).searchParams);
  assert.equal((await owner('GET', `/api/oauth/request?${new URLSearchParams(p4)}`)).status, 403);
  await owner('PATCH', '/api/orgs/current', { allow_api_tokens: true });
});
