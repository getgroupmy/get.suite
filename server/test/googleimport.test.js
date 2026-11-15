import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-gimport-'));
const { createOrg } = await import('../src/tenancy.js');
const { q } = await import('../src/db.js');
const { googleSignInUrl, finishGoogleSignIn, cleanGoogleApp, googleAppOf, GOOGLE_SCOPE } = await import('../src/mail/googleimport.js');

let g; const posted = [];
const jwt = (p) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
before(async () => {
  g = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = Object.fromEntries(new URLSearchParams(body));
      posted.push(f);
      res.setHeader('content-type', 'application/json');
      if (f.code === 'bad') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' })); }
      res.end(JSON.stringify({ access_token: 'ya29.fake', scope: f.code === 'nomail' ? 'openid email' : GOOGLE_SCOPE, id_token: jwt({ email: 'Ana@Gmail.com', email_verified: true }) }));
    });
  });
  await new Promise((r) => g.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${g.address().port}/token`;
});
after(() => g.close());

test('the company’s Google client, checked; the secret is kept unless replaced', () => {
  assert.deepEqual(cleanGoogleApp({ client_id: ' 123-abc.apps.googleusercontent.com ', client_secret: 'GOCSPX-abcdefghijkl' }), { clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-abcdefghijkl' });
  assert.equal(cleanGoogleApp({ client_id: '123-abc.apps.googleusercontent.com' }).secret, undefined, 'left out: kept');
  assert.throws(() => cleanGoogleApp({ client_id: 'my-client' }), /apps\.googleusercontent\.com/);
  assert.throws(() => cleanGoogleApp({ client_id: '1.apps.googleusercontent.com', client_secret: 'a b' }), /secret/);
});

test('sign in at Google (PKCE and a one-time state), then the import starts with the access Google gives', async () => {
  const { id: orgId, userId } = createOrg({ name: 'Acme', domain: 'acme.com', adminName: 'Ana', adminLocal: 'ana', adminPassword: 'password123' });
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  assert.throws(() => googleSignInUrl(user, { base: 'https://work.acme.com' }), /hasn’t set up importing from Google/);
  q('UPDATE orgs SET g_client_id = ?, g_client_secret = ? WHERE id = ?').run('123-abc.apps.googleusercontent.com', 'GOCSPX-secret-value', orgId);
  assert.equal(googleAppOf(orgId).clientId, '123-abc.apps.googleusercontent.com');
  const url = new URL(googleSignInUrl(user, { email: 'ana@gmail.com', base: 'https://work.acme.com/' }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.scope, p.code_challenge_method, p.login_hint], ['123-abc.apps.googleusercontent.com', 'https://work.acme.com/api/mail/import/google/callback', 'code', GOOGLE_SCOPE, 'S256', 'ana@gmail.com']);
  const started = [];
  const start = async (u, o) => { started.push(o); return { status: 'running' }; };
  await assert.rejects(finishGoogleSignIn(user, { code: 'c', state: 'forged', base: 'https://work.acme.com' }, { start }), /expired or isn’t yours/);
  const out = await finishGoogleSignIn(user, { code: 'good', state: p.state, base: 'https://work.acme.com' }, { start });
  assert.equal(out.status, 'running');
  assert.deepEqual(started[0], { host: 'imap.gmail.com', port: 993, username: 'ana@gmail.com', accessToken: 'ya29.fake' });
  const sent = posted.at(-1);
  assert.equal(sent.client_secret, 'GOCSPX-secret-value');
  assert.equal(crypto.createHash('sha256').update(sent.code_verifier).digest('base64url'), p.code_challenge, 'the PKCE verifier matches');
  await assert.rejects(finishGoogleSignIn(user, { code: 'good', state: p.state, base: 'https://work.acme.com' }, { start }), /expired/, 'a state works once');
  // Someone else's state can't be used.
  const other = createOrg({ name: 'Globex', domain: 'globex.com', adminName: 'Gil', adminLocal: 'gil', adminPassword: 'password123' });
  const st = new URL(googleSignInUrl(user, { base: 'https://work.acme.com' })).searchParams.get('state');
  await assert.rejects(finishGoogleSignIn(q('SELECT * FROM users WHERE id = ?').get(other.userId), { code: 'good', state: st, base: 'x' }, { start }), /isn’t yours/);
});

test('said no at Google, no mail access ticked, or a bad code: said so, nothing started', async () => {
  const user = q("SELECT * FROM users WHERE username = 'ana@acme.com'").get();
  const started = [];
  const start = async (u, o) => { started.push(o); };
  const st = () => new URL(googleSignInUrl(user, { base: 'https://w' })).searchParams.get('state');
  await assert.rejects(finishGoogleSignIn(user, { error: 'access_denied', state: st(), base: 'https://w' }, { start }), /didn’t let Workspace read/);
  await assert.rejects(finishGoogleSignIn(user, { code: 'nomail', state: st(), base: 'https://w' }, { start }), /tick the box for Gmail/);
  await assert.rejects(finishGoogleSignIn(user, { code: 'bad', state: st(), base: 'https://w' }, { start }), /didn’t complete the sign-in: Bad Request/);
  assert.equal(started.length, 0);
});

test('calendars and contacts from Google: the main calendar into yours, others as their own; contacts once', async () => {
  const { bringGoogleData } = await import('../src/mail/googleimport.js');
  const api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ya29.data') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'Invalid Credentials' } })); }
    if (req.url.startsWith('/calendar/v3/users/me/calendarList')) return res.end(JSON.stringify({ items: [{ id: 'ana@gmail.com', summary: 'ana@gmail.com', primary: true }, { id: 'club@group', summary: 'Running club' }] }));
    if (req.url.startsWith('/calendar/v3/calendars/ana%40gmail.com/events')) return res.end(JSON.stringify({ items: [{ id: 'e1', iCalUID: 'e1@google.com', summary: 'Dentist', start: { dateTime: '2026-12-03T09:00:00Z' }, end: { dateTime: '2026-12-03T10:00:00Z' } }] }));
    if (req.url.startsWith('/calendar/v3/calendars/club%40group/events')) {
      if (!req.url.includes('pageToken')) return res.end(JSON.stringify({ items: [{ id: 'e2', summary: 'Long run', start: { date: '2026-12-06' }, end: { date: '2026-12-07' } }], nextPageToken: 'p2' }));
      return res.end(JSON.stringify({ items: [{ id: 'e3', summary: 'Track night', start: { dateTime: '2026-12-08T18:00:00Z' }, end: { dateTime: '2026-12-08T19:00:00Z' }, recurrence: ['RRULE:FREQ=WEEKLY'] }] }));
    }
    if (req.url.startsWith('/drive/v3/files?')) {
      const q2 = new URL(req.url, 'http://x').searchParams.get('q');
      if (q2.startsWith("'root'")) return res.end(JSON.stringify({ files: [{ id: 'fold', name: 'Plans', mimeType: 'application/vnd.google-apps.folder' }, { id: 'doc', name: 'Roadmap', mimeType: 'application/vnd.google-apps.document' }, { id: 'form', name: 'Survey', mimeType: 'application/vnd.google-apps.form' }] }));
      if (q2.startsWith("'fold'")) return res.end(JSON.stringify({ files: [{ id: 'pdf', name: 'Budget.pdf', mimeType: 'application/pdf', size: '9' }] }));
    }
    if (req.url.startsWith('/drive/v3/files/doc/export')) { res.setHeader('content-type', 'application/octet-stream'); return res.end(`docx of roadmap ${new URL(req.url, 'http://x').searchParams.get('mimeType').includes('wordprocessingml')}`); }
    if (req.url.startsWith('/drive/v3/files/pdf?alt=media')) { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.7'); }
    if (req.url.startsWith('/v1/people/me/connections')) return res.end(JSON.stringify({ connections: [{ resourceName: 'people/1', names: [{ displayName: 'Grace Hopper' }], emailAddresses: [{ value: 'grace@example.com' }] }, { resourceName: 'people/2', names: [{ displayName: 'Alan Turing' }], emailAddresses: [{ value: 'alan@example.com' }] }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_API_URL = process.env.GOOGLE_PEOPLE_URL = `http://127.0.0.1:${api.address().port}`;
  try {
    const user = q("SELECT * FROM users WHERE username = 'ana@acme.com'").get();
    const r = await bringGoogleData(user, 'ya29.data');
    assert.deepEqual([r.calendar.added, r.calendar.calendars], [3, ['Running club']]);
    assert.deepEqual([r.contacts.added, r.contacts.skipped], [2, 0]);
    const evs = q('SELECT title, calendar_id, rrule FROM events WHERE owner_id = ? ORDER BY title').all(user.id);
    assert.deepEqual(evs.map((e) => [e.title, !!e.calendar_id, !!e.rrule]), [['Dentist', false, false], ['Long run', true, false], ['Track night', true, true]]);
    const again = await bringGoogleData(user, 'ya29.data');
    assert.deepEqual([again.calendar.added, again.contacts.added], [0, 0], 'nothing twice');
    assert.equal(q("SELECT COUNT(*) AS n FROM user_calendars WHERE owner_id = ? AND name = 'Running club'").get(user.id).n, 1);
    await assert.rejects(bringGoogleData(user, 'wrong'), /Couldn’t read your Google calendars: Invalid Credentials/);
    const onlyContacts = await bringGoogleData(user, 'ya29.data', { calendar: false });
    assert.equal(onlyContacts.calendar, undefined);
    // Drive: folders kept, Google Docs as Word files, other Google kinds (Forms) left out.
    const steps = [];
    const d = await bringGoogleData(user, 'ya29.data', { calendar: false, contacts: false, drive: true }, (st) => steps.push(st));
    assert.deepEqual(steps, ['drive']);
    assert.equal(d.drive.files, 2);
    const { FILES_DIR } = await import('../src/db.js');
    const doc = q("SELECT storage FROM files WHERE owner_id = ? AND name = 'Roadmap.docx'").get(user.id);
    assert.equal(fs.readFileSync(path.join(FILES_DIR, doc.storage), 'utf8'), 'docx of roadmap true');
    assert.equal(q("SELECT p.name FROM files f JOIN files p ON p.id = f.parent_id WHERE f.owner_id = ? AND f.name = 'Budget.pdf'").get(user.id).name, 'Plans');
    assert.equal(q("SELECT COUNT(*) AS n FROM files WHERE owner_id = ? AND name LIKE 'Survey%'").get(user.id).n, 0);
  } finally { api.close(); delete process.env.GOOGLE_API_URL; delete process.env.GOOGLE_PEOPLE_URL; }
});
