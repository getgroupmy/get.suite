// e2e-env: FOCUS_SECONDS_PER_MINUTE=1
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
let task;
await step('a focus session ends: the top bar offers another one or a break', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  task = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Write the report' })).body.id;
  await page.goto(`${B}/drive`);
  await page.evaluate(() => localStorage.setItem('nw-break-seconds', '4'));
  await api(page, 'POST', `/tasks/tasks/${task}/timer`, { minutes: 5 }); // 5 seconds in this test (FOCUS_SECONDS_PER_MINUTE=1)
  await page.reload();
  await page.getByRole('status', { name: /^Write the report: \d min left$/ }).waitFor({ timeout: 10000 });
  const done = page.getByRole('status', { name: 'Focus session done: Write the report' });
  await done.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/focus-done.png` });
  // Another one: a new 5-minute session on the same task.
  await done.getByRole('button', { name: 'Another 5 min' }).click();
  await page.getByText('Focus for 5 minutes on Write the report').last().waitFor({ timeout: 10000 });
  const t = (await api(page, 'GET', '/tasks/timer')).body;
  if (!t || t.task_id !== task || Math.round((t.until - t.since) / 1e3) !== 5) throw new Error(JSON.stringify(t));
});
await step('a 5-minute break, counted down; when it’s over, back to the task', async () => {
  const done = page.getByRole('status', { name: 'Focus session done: Write the report' });
  await done.getByRole('button', { name: '5-min break' }).click({ timeout: 15000 });
  await page.getByRole('status', { name: /^Break: 1 min left$/ }).waitFor(); // 4 seconds in this test
  await page.reload(); // kept across reloads
  await page.getByRole('status', { name: /^Break: \d min left$/ }).waitFor({ timeout: 10000 });
  await page.getByText('Break’s over').last().waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Focus on Write the report' }).last().click();
  await page.getByText('Focus for 5 minutes on Write the report').last().waitFor({ timeout: 10000 });
  if (!(await api(page, 'GET', '/tasks/timer')).body) throw new Error('no session');
  await api(page, 'POST', '/tasks/timer/stop');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
