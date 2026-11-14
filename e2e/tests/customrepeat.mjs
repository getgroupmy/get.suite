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
let list;
const tasks = async () => (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
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
  list = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  await page.goto(`${B}/tasks/${list}`);
});
await step('quick add understands "every 2 weeks on mon and thu"', async () => {
  const box = page.getByPlaceholder('Add a task');
  await box.fill('Gym every 2 weeks on mon and thu');
  await page.locator('.chip', { hasText: 'Every 2 weeks on Mon, Thu' }).waitFor();
  await box.press('Enter');
  const t = await until(async () => (await tasks()).find((x) => x.title === 'Gym'));
  if (t.repeat !== 'every:2:week:1,4') throw new Error(t.repeat);
  await page.locator('.task-repeat', { hasText: 'Every 2 weeks on Mon, Thu' }).waitFor();
});
await step('Custom… in a task’s details: every 3 months', async () => {
  await page.getByPlaceholder('Add a task').fill('Review budget tomorrow');
  await page.getByPlaceholder('Add a task').press('Enter');
  const t = await until(async () => (await tasks()).find((x) => x.title === 'Review budget'));
  await page.getByText('Review budget', { exact: true }).click();
  await page.getByLabel('Repeat', { exact: true }).selectOption('custom');
  const g = page.getByRole('group', { name: 'Custom repeat' });
  await g.getByLabel('Repeat every').fill('3');
  await g.getByLabel('Repeat unit').selectOption('month');
  await g.getByText('Every 3 months').waitFor();
  await page.screenshot({ path: `${SP}/shots/customrepeat.png` });
  await g.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await tasks()).find((x) => x.id === t.id).repeat === 'every:3:month');
  if ((await page.getByLabel('Repeat', { exact: true }).locator('option:checked').innerText()) !== 'Every 3 months') throw new Error('shows the custom one');
});
await step('weekly on chosen days with the day buttons', async () => {
  await page.getByLabel('Repeat', { exact: true }).selectOption('custom');
  const g = page.getByRole('group', { name: 'Custom repeat' });
  await g.getByLabel('Repeat every').fill('1');
  await g.getByLabel('Repeat unit').selectOption('week');
  await g.getByRole('button', { name: 'Tue' }).click();
  await g.getByRole('button', { name: 'Fri' }).click();
  await g.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await tasks()).find((x) => x.title === 'Review budget').repeat === 'every:1:week:2,5');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
