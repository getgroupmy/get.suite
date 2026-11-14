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
await step('quiet hours need working hours first', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Quiet hours' });
  await card.getByText('Set your working hours first').waitFor();
  if (!(await card.getByLabel('Pause notifications outside my working hours').isDisabled())) throw new Error('enabled');
});
await step('turned on outside working hours: 🔕 shows quiet hours, and leads to Settings', async () => {
  const today = new Date().getDay(); // working hours that skip today: it's outside them now
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);
  await api(page, 'PUT', '/users/me/work-hours', { hours: { days, start: 9 * 60, end: 17 * 60, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  await page.reload();
  const card = page.getByRole('region', { name: 'Quiet hours' });
  await card.getByText(/Your working hours: .*9:00–17:00/).waitFor();
  await card.getByLabel('Pause notifications outside my working hours').check();
  await page.getByText('Notifications pause outside your working hours').waitFor();
  const mark = page.getByRole('button', { name: /^Quiet hours until/ });
  await mark.waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Quiet hours until/ }).click();
  await page.waitForURL(/\/settings/);
  await page.getByRole('region', { name: 'Quiet hours' }).getByLabel('Pause notifications outside my working hours').uncheck();
  await page.getByText('Quiet hours off').waitFor();
  await until(async () => !(await page.getByRole('button', { name: /^Quiet hours until/ }).count()));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
