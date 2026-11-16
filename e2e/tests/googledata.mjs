// e2e-env: GOOGLE_AUTH_URL=http://127.0.0.1:8190/auth GOOGLE_TOKEN_URL=http://127.0.0.1:8190/token GOOGLE_API_URL=http://127.0.0.1:8190 GOOGLE_PEOPLE_URL=http://127.0.0.1:8190
import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
// A stand-in for Google: sign-in (says yes at once), tokens, and the Calendar and People APIs.
const http = await import('node:http');
const asked = {};
const g = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/auth') {
    asked.auth = Object.fromEntries(u.searchParams);
    const back = new URL(asked.auth.redirect_uri); back.searchParams.set('code', 'c1'); back.searchParams.set('state', asked.auth.state);
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (u.pathname === '/token') return json({ access_token: 'ya29.data', scope: 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/drive.readonly', id_token: `x.${Buffer.from(JSON.stringify({ email: 'ana@gmail.com' })).toString('base64url')}.y` });
  if (u.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [{ id: 'ana@gmail.com', summary: 'ana@gmail.com', primary: true }, { id: 'club', summary: 'Running club' }] });
  if (u.pathname === '/calendar/v3/calendars/ana%40gmail.com/events' || u.pathname === '/calendar/v3/calendars/ana@gmail.com/events') return json({ items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-12-03T09:00:00Z' }, end: { dateTime: '2026-12-03T10:00:00Z' } }] });
  if (u.pathname === '/calendar/v3/calendars/club/events') return json({ items: [{ id: 'e2', summary: 'Long run', start: { date: '2026-12-06' }, end: { date: '2026-12-07' } }] });
  if (u.pathname === '/drive/v3/files') return json(u.searchParams.get('q').startsWith("'root'") ? { files: [{ id: 'doc', name: 'Roadmap', mimeType: 'application/vnd.google-apps.document' }] } : { files: [] });
  if (u.pathname === '/drive/v3/files/doc/export') { res.end('docx bytes'); return; }
  if (u.pathname === '/v1/people/me/connections') return json({ connections: [{ resourceName: 'people/1', names: [{ displayName: 'Grace Hopper' }], emailAddresses: [{ value: 'grace@example.com' }] }] });
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => g.listen(8190, '127.0.0.1', r));
await step('Settings → Move here → Google: calendars, contacts and Drive straight from Google, no export', async () => {
  await api(page, 'PATCH', '/orgs/current', { g_client_id: '1234-abc.apps.googleusercontent.com', g_client_secret: 'GOCSPX-test-secret-1' });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByRole('button', { name: 'Calendars, contacts and Drive from Google…' }).click();
  await card.getByRole('status', { name: 'From Google' }).getByText(/From Google: 2 events \(with Running club as calendars of their own\), 1 contact, 1 file into “From Google \d{4}-\d\d-\d\d” in Drive brought in\./).waitFor({ timeout: 20000 });
  if (!asked.auth.scope.includes('drive.readonly') || asked.auth.scope.includes('mail.google.com')) throw new Error(asked.auth.scope);
  if (!/\/settings#move-here$/.test(page.url())) throw new Error(page.url());
  await page.screenshot({ path: `${SP}/shots/googledata.png` });
  await page.goto(`${B}/contacts`);
  await page.getByText('Grace Hopper').first().waitFor();
  const cals = (await api(page, 'GET', '/events/calendars')).body;
  if (!JSON.stringify(cals).includes('Running club')) throw new Error('no Running club calendar');
});
await step('the Moving here page shows it', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Moving here' }).or(page.getByRole('button', { name: 'Moving here' })).first().click();
  await page.getByRole('table', { name: 'People' }).getByText('From Google: 1 file, 2 events, 1 contact').waitFor();
});
await step('without the company’s Google client there’s no button', async () => {
  await api(page, 'PATCH', '/orgs/current', { g_client_id: '' });
  await page.goto(`${B}/settings`);
  await page.getByRole('region', { name: 'Move here from another service' }).getByRole('button', { name: 'Bring in a .zip…' }).waitFor();
  if (await page.getByRole('button', { name: 'Calendars, contacts and Drive from Google…' }).count()) throw new Error('button still there');
});
g.close();
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
