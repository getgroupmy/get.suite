import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let token;
const bearer = (t, method, url, body) => fetch(`${B}/api${url}`, { method, headers: { authorization: `Bearer ${t}`, ...(body && { 'content-type': 'application/json' }) }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
await step('off until an admin turns API tokens on in Company settings', async () => {
  await kim.goto(`${B}/settings`);
  const sec = kim.getByRole('region', { name: 'API tokens' });
  await sec.getByText(/Your company hasn't turned on API tokens/).waitFor();
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  await page.getByLabel(/Let people make API tokens/).check();
  await page.getByText('People can make API tokens').waitFor();
});
await step('Kim makes a read-and-write token, sees it once, and a script uses it', async () => {
  await kim.reload();
  const sec = kim.getByRole('region', { name: 'API tokens' });
  await sec.getByRole('button', { name: 'New token' }).click();
  await sec.getByLabel("What it's for").fill('Scanner uploads');
  await sec.getByLabel('Access').selectOption('write');
  await sec.getByLabel('Expires').selectOption('30');
  await sec.getByRole('button', { name: 'Make token' }).click();
  token = (await sec.getByLabel('New API token').innerText()).trim();
  if (!/^nwt_/.test(token)) throw new Error(token);
  const r = await bearer(token, 'POST', '/files/folder', { name: 'Scans' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await sec.getByRole('button', { name: "Done, I've copied it" }).click();
  if (await sec.getByLabel('New API token').count()) throw new Error('still shown');
  await kim.reload();
  const row = kim.getByRole('list', { name: 'Your API tokens' }).getByRole('listitem').filter({ hasText: 'Scanner uploads' });
  await row.getByText(/read and write/).waitFor();
  await row.getByText(/last used/).waitFor();
  if ((await kim.content()).includes(token)) throw new Error('the token is on the page again');
  await kim.goto(`${B}/drive`);
  await kim.getByText('Scans', { exact: true }).first().waitFor();
});
await step('the admin sees it in the company list and revokes it; the script is refused', async () => {
  await page.reload();
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const list = page.getByRole('region', { name: 'API tokens in the company' });
  await list.getByText('Scanner uploads').waitFor();
  await list.getByRole('button', { name: 'Revoke Scanner uploads of Kim Park' }).click();
  await page.getByText('“Scanner uploads” revoked').waitFor();
  if ((await bearer(token, 'GET', '/files')).status !== 401) throw new Error('still works');
});
await step('Kim revokes their own token after confirming', async () => {
  const t2 = (await api(kim, 'POST', '/tokens', { name: 'Report', scope: 'read', days: 90 })).body.token;
  if ((await bearer(t2, 'GET', '/files')).status !== 200) throw new Error('read');
  if ((await bearer(t2, 'POST', '/files/folder', { name: 'x' })).status !== 403) throw new Error('read-only');
  await kim.goto(`${B}/settings`);
  const sec = kim.getByRole('region', { name: 'API tokens' });
  await sec.getByRole('button', { name: 'Revoke Report' }).click();
  await kim.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await kim.getByText('“Report” revoked').waitFor();
  if ((await bearer(t2, 'GET', '/files')).status !== 401) throw new Error('still works');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
