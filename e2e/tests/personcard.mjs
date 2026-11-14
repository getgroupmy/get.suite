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
let ids = {};
await step('colleagues with jobs and managers', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['max', 'Max Lee'], ['ray', 'Ray Tan']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await api(page, 'PATCH', `/users/${ids.kim}`, { job_title: 'Designer', department: 'Product', work_phone: '+60 3-555 0101', manager_id: ids.max });
  await api(page, 'PATCH', `/users/${ids.max}`, { job_title: 'Head of Product' });
  await api(page, 'PATCH', `/users/${ids.ray}`, { manager_id: ids.kim, job_title: 'Intern' });
});
await step('clicking a name in the Directory opens their card', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.getByRole('button', { name: 'Kim Park', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Kim Park' });
  await d.getByText('Designer · Product').waitFor();
  await d.getByRole('link', { name: 'kim@acme.com' }).waitFor();
  await d.getByRole('link', { name: '+60 3-555 0101' }).waitFor();
  await d.getByText('Reports to').waitFor();
  await d.getByRole('button', { name: 'Ray Tan' }).waitFor();
  // Going up the chart inside the card.
  await d.getByRole('button', { name: 'Max Lee' }).click();
  const m = page.getByRole('dialog', { name: 'Max Lee' });
  await m.getByText('Head of Product').waitFor();
  await m.getByRole('button', { name: 'Kim Park' }).waitFor();
});
await step('Message opens a chat with them; See their calendar adds them there', async () => {
  const m = page.getByRole('dialog', { name: 'Max Lee' });
  await m.getByRole('button', { name: 'See their calendar' }).click();
  await page.waitForURL(/\/calendar/);
  await page.locator('.other-cal', { hasText: 'Max Lee' }).waitFor();
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.getByRole('button', { name: 'Org chart' }).click();
  await page.getByRole('list', { name: 'Org chart' }).getByRole('button', { name: 'Ray Tan', exact: true }).click();
  const r = page.getByRole('dialog', { name: 'Ray Tan' });
  await r.getByText('Intern').waitFor();
  await r.getByRole('button', { name: 'Message' }).click();
  await page.waitForURL(/\/chat\//);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
