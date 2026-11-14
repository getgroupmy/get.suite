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
const loc = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
await step('Schedule time: warned about a clash, booked on the calendar, opened from the task', async () => {
  const day = new Date(); day.setDate(day.getDate() + 2); day.setHours(10, 0, 0, 0);
  const at = day.getTime();
  await api(page, 'POST', '/events', { title: 'Team meeting', start: at + 30 * 60e3, end: at + 90 * 60e3 });
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  const t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Write the report' })).body;
  await page.goto(`${B}/tasks/${list}?task=${t.id}`);
  const sec = page.getByRole('region', { name: 'Schedule time' });
  await sec.getByRole('button', { name: '+ Book time on my calendar' }).click();
  await sec.getByLabel('Starts').fill(loc(at));
  await sec.getByLabel('For how long').selectOption('60');
  await sec.getByText('⚠ Clashes with Team meeting').waitFor();
  await sec.getByLabel('Starts').fill(loc(at + 2 * 36e5));
  await until(async () => !(await sec.getByText('⚠ Clashes').count()));
  await sec.getByLabel('Starts').fill(loc(at - 36e5));
  await sec.getByRole('button', { name: 'Book' }).click();
  await page.getByText(/^On your calendar: /).waitFor();
  const link = sec.getByRole('list', { name: 'Time booked on your calendar' }).getByRole('link');
  await link.waitFor();
  await page.screenshot({ path: `${SP}/shots/task-schedule.png` });
  const ev = (await api(page, 'GET', `/events?from=${at - 2 * 36e5}&to=${at}`)).body.find((e) => e.task_id === t.id);
  if (!ev || ev.title !== '✓ Write the report' || ev.start !== at - 36e5 || ev.end !== at) throw new Error(JSON.stringify(ev));
  await link.click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.waitFor();
  if (await d.getByLabel('Title').inputValue() !== '✓ Write the report') throw new Error('wrong event');
  // And back: Open task in the event's window.
  await d.getByRole('link', { name: /Open task/ }).click();
  await until(async () => page.url().includes(`?task=${t.id}`));
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('region', { name: 'Schedule time' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
