// e2e-env: MS_LOGIN_URL=http://127.0.0.1:8191 MS_GRAPH_URL=http://127.0.0.1:8191
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
// A stand-in for Microsoft: the sign-in with a code (pending once, then a token), and Graph.
const http = await import('node:http');
let polls = 0; const asked = [];
const ms = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    asked.push({ url: req.url, ...Object.fromEntries(new URLSearchParams(body)) });
    if (req.url.endsWith('/devicecode')) return json({ device_code: 'DEV', user_code: 'MSFT-2026', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
    if (req.url.endsWith('/token')) return ++polls < 2 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'eyJ.graph', token_type: 'Bearer', expires_in: 3600 });
    if (req.url.startsWith('/download/')) { res.end('the plan'); return; }
    if (req.url.startsWith('/v1.0/me/calendars?')) return json({ value: [{ id: 'main', name: 'Calendar', isDefaultCalendar: true }] });
    if (req.url.startsWith('/v1.0/me/calendars/main/events')) return json({ value: [{ id: 'e1', subject: 'Quarterly review', type: 'singleInstance', start: { dateTime: '2026-12-03T09:00:00.0000000' }, end: { dateTime: '2026-12-03T10:00:00.0000000' } }] });
    if (req.url.startsWith('/v1.0/me/contacts')) return json({ value: [{ id: 'c1', displayName: 'Katherine Johnson', emailAddresses: [{ address: 'kj@nasa.gov' }], spouseName: 'James Johnson', manager: 'Al Harrison' }] });
    if (req.url.startsWith('/v1.0/me/drive/root/children')) return json({ value: [{ id: 'p', name: 'Plan.docx', file: {}, size: 8, '@microsoft.graph.downloadUrl': 'http://127.0.0.1:8191/download/plan' }] });
    json({}, 404);
  });
});
await new Promise((r) => ms.listen(8191, '127.0.0.1', r));
await step('Settings → Move here → Microsoft: a code to enter at Microsoft, then calendars, contacts and OneDrive come in', async () => {
  await api(page, 'PATCH', '/orgs/current', { ms_client_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByRole('button', { name: 'Microsoft 365 or Outlook.com' }).click();
  await card.getByRole('button', { name: 'Calendars, contacts and OneDrive from Microsoft…' }).click();
  const box = card.getByRole('status', { name: 'From Microsoft' });
  await box.getByLabel('Your code').filter({ hasText: 'MSFT-2026' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/msdata-code.png` });
  await axe(page, 'ms data code');
  await box.getByText(/From Microsoft: 1 event, 1 contact, 1 file into “From Microsoft \d{4}-\d\d-\d\d” in Drive brought in\./).waitFor({ timeout: 30000 });
  if (!asked[0].scope.includes('Calendars.Read') || asked[0].scope.includes('IMAP')) throw new Error(asked[0].scope);
  await page.goto(`${B}/contacts`);
  await page.getByText('Katherine Johnson').first().waitFor();
  await page.locator('tbody tr', { hasText: 'Katherine Johnson' }).getByText('Spouse: James Johnson · Manager: Al Harrison').waitFor(); // related people come too
  await page.goto(`${B}/drive`);
  await page.getByText(/From Microsoft \d{4}/).first().waitFor();
});
await step('Admin → Moving here shows it', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Moving here' }).or(page.getByRole('button', { name: 'Moving here' })).first().click();
  await page.getByRole('table', { name: 'People' }).getByText('From Microsoft: 1 file, 1 event, 1 contact').waitFor();
});
ms.close();
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
