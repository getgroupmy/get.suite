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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const group = (name) => page.getByRole('region', { name, exact: true });
const titles = (name) => group(name).locator('.task-title').allInnerTexts();
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
  const mine = (await api(page, 'GET', '/tasks/lists')).body.lists[0].id;
  const work = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  for (const [list, title, due] of [[mine, 'Pay rent', day(-2)], [work, 'Send report', day(0)], [mine, 'Dentist', day(1)], [work, 'Plan offsite', day(4)], [mine, 'Renew passport', day(40)], [work, 'Someday', null]]) {
    await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title, ...(due && { due }) });
  }
  await page.goto(`${B}/tasks`);
});
await step('Planned: dated tasks from every list, grouped by when they’re due', async () => {
  const nav = page.getByRole('button', { name: /^Planned/ });
  await until(async () => (await nav.innerText()).includes('2'), 8000); // overdue + today
  await nav.click();
  await page.getByRole('heading', { name: 'Planned' }).waitFor();
  await group('Overdue').waitFor();
  const got = await Promise.all(['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later'].map(titles));
  if (JSON.stringify(got) !== JSON.stringify([['Pay rent'], ['Send report'], ['Dentist'], ['Plan offsite'], ['Renew passport']])) throw new Error(JSON.stringify(got));
  if (await page.getByText('Someday').count()) throw new Error('undated ones are not planned');
  if (!(await group('Today').innerText()).includes('Work')) throw new Error('shows the list');
  await page.screenshot({ path: `${SP}/shots/planned.png` });
});
await step('ticking one off takes it out, and the count follows', async () => {
  await group('Overdue').getByRole('checkbox').first().click();
  await until(async () => (await group('Overdue').count()) === 0);
  await until(async () => (await page.getByRole('button', { name: /^Planned/ }).innerText()).trim().endsWith('1'));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
