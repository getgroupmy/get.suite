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
await step('Focus time… from the sidebar makes a focus block', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Focus time…' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  if (!(await d.getByLabel('Focus time').isChecked())) throw new Error('not ticked');
  await d.getByText('notifications are paused').waitFor();
  if (await d.getByLabel('Location').count()) throw new Error('location offered');
  if (await d.getByRole('button', { name: 'Add video meeting' }).count()) throw new Error('meeting offered');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  const ev = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 2 * 864e5}`)).body.find((e) => e.title === 'Focus time');
  if (ev?.kind !== 'focus') throw new Error(JSON.stringify(ev));
});
await step('while it is on, notifications show as paused', async () => {
  const now = Date.now();
  await api(page, 'POST', '/events', { title: 'Deep work', kind: 'focus', start: now - 60e3, end: now + 36e5 });
  await page.reload();
  await page.locator('.paused-mark').waitFor();
});
await step('tick Out of office and Focus time are one or the other', async () => {
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByLabel('Focus time').check();
  await d.getByLabel('Out of office').check();
  if (await d.getByLabel('Focus time').isChecked()) throw new Error('both ticked');
  await d.getByRole('button', { name: 'Cancel' }).click().catch(() => page.keyboard.press('Escape'));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
