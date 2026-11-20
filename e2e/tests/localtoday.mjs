// Dates "today" in the browser, in Kuala Lumpur at 7:30 on Saturday morning (still Friday 23:30 in UTC): Tasks → Add
// time starts on today there and lets you choose it (before, it offered Friday and today was past its latest day).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Kuala_Lumpur' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const details = (p) => p.getByRole('complementary', { name: 'Task details' });
const timeBox = (p) => details(p).getByRole('region', { name: 'Time' });
const row = (p, t) => p.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
let list;
await step('setup: a list with a task, at 7:30 on Saturday 21 November in Kuala Lumpur', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  list = (await api('POST', '/tasks/lists', { name: 'Client work' })).body.id;
  await api('POST', `/tasks/lists/${list}/tasks`, { title: 'Design' });
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 10, 20, 23, 30)));
});
await step('Add time: the day is today there, and today can be chosen', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await row(page, 'Design').locator('.task-main').click();
  await timeBox(page).getByRole('button', { name: 'Add time' }).click();
  const day = timeBox(page).getByLabel('Day');
  const [value, max] = [await day.inputValue(), await day.getAttribute('max')];
  if (value !== '2026-11-21' || max !== '2026-11-21') throw new Error(`the day is ${value}, latest ${max}`);
  await timeBox(page).getByLabel('How long').fill('45m');
  await timeBox(page).getByRole('button', { name: 'Add', exact: true }).click();
  await timeBox(page).getByText(/45 min/).first().waitFor({ timeout: 8000 });
  const line = await timeBox(page).getByRole('list', { name: 'Time entries' }).innerText();
  if (!/21 Nov|Nov 21/.test(line)) throw new Error(`the entry reads: ${line}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
