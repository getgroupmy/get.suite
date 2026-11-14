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
const fromIp = (p, ip) => p.evaluate(async (x) => (await fetch('/api/files?view=mine', { headers: { 'x-requested-with': 'nas-workspace', 'x-forwarded-for': x } })).status, ip);
let kim;
await step('limit Workspace to the office network (your own address is filled in)', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click();
  const card = page.getByRole('form', { name: 'Networks' });
  await card.getByLabel('Only from these addresses and ranges (offices, VPN)').check();
  const box = card.getByLabel('Addresses and ranges, one per line');
  const mine = await box.inputValue();
  if (!mine) throw new Error('own address not filled in');
  await box.fill(`${mine}\n203.0.113.0/24`);
  await card.getByRole('button', { name: 'Save networks' }).click();
  await page.getByText('Workspace now works only from these networks').waitFor();
});
await step('from elsewhere, colleagues are refused; from the office they are not', async () => {
  if (await fromIp(kim, '198.51.100.9') !== 403) throw new Error('allowed from elsewhere');
  if (await fromIp(kim, '203.0.113.20') !== 200) throw new Error('refused from the office');
  const card = page.getByRole('form', { name: 'Networks' });
  await card.getByLabel('Workspace works from anywhere').check();
  await card.getByRole('button', { name: 'Save networks' }).click();
  await page.getByText('Workspace works from anywhere').last().waitFor();
  if (await fromIp(kim, '198.51.100.9') !== 200) throw new Error('still refused');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
