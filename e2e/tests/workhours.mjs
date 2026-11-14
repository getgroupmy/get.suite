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
await step('Kim sets her working hours: Tuesday and Thursday afternoons', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('button', { name: 'Working hours' }).click();
  const d = kim.getByRole('dialog', { name: 'Working hours' });
  for (const day of ['Mon', 'Wed', 'Fri']) await d.getByLabel(day, { exact: true }).uncheck();
  await d.getByLabel('From').fill('13:00');
  await d.getByLabel('To').fill('17:00');
  await d.getByRole('button', { name: 'Save' }).click();
  await kim.getByText('Working hours: Tue, Thu 13:00–17:00').waitFor();
}, kim);
await step('Find a time only offers times inside them, and says whose hours', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByLabel('Title').fill('Planning');
  await d.locator('#guest-input').fill('kim@acme.com,');
  await d.getByRole('button', { name: 'Find a time with 1 guest' }).click();
  const slots = d.getByRole('group', { name: 'Free times' });
  await slots.getByRole('button').first().waitFor();
  const all = await slots.getByRole('button').allInnerTexts();
  if (!all.every((t) => /^(Tue|Thu), .*(1|2|3|4):(00|30)\s?PM – /.test(t))) throw new Error(all.join(' | '));
  await d.getByText('Kim Park: Tue, Thu 13:00–17:00', { exact: false }).waitFor();
  await page.screenshot({ path: `${SP}/shots/workhours.png` });
});
await step('back to the usual hours', async () => {
  await kim.getByRole('button', { name: 'Working hours' }).click();
  const d = kim.getByRole('dialog', { name: 'Working hours' });
  await d.getByRole('button', { name: /Use the usual/ }).click();
  await kim.getByText('Back to the usual hours').waitFor();
}, kim);
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
