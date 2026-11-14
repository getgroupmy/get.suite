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
let kim, ch;
await step('a group and a channel', async () => {
  const kid = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const g = (await api(page, 'POST', '/groups', { name: 'Field Sales' })).body;
  await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [kid] });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'deals' })).body;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('typing @fie suggests the group; the message highlights it and Kim is told', async () => {
  await page.goto(`${B}/chat/${ch.id}`);
  const box = page.getByLabel('Message', { exact: true });
  await box.click();
  await page.keyboard.type('Big order in @fie');
  const opt = page.getByRole('listbox', { name: 'People to mention' }).getByRole('option', { name: /Field Sales/ });
  await opt.waitFor();
  await page.keyboard.press('Enter');
  if (await box.inputValue() !== 'Big order in @field-sales ') throw new Error(await box.inputValue());
  await page.keyboard.press('Enter');
  await page.locator('.msg .mention.group', { hasText: '@field-sales' }).waitFor();
  await kim.goto(`${B}/chat`);
  await kim.getByRole('button', { name: /Notifications, \d+ new/ }).click();
  await kim.getByText('Olivia Owner mentioned you in #deals').waitFor();
});
await step('@channel is suggested too', async () => {
  const box = page.getByLabel('Message', { exact: true });
  await box.click();
  await page.keyboard.type('@chan');
  await page.getByRole('option', { name: /Everyone in this conversation/ }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
