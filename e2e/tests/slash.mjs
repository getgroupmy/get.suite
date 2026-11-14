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
let general;
const box = () => page.getByLabel('Message', { exact: true });
await step('typing / lists the commands; picking one fills it in', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await box().fill('/');
  const list = page.getByRole('listbox', { name: 'Commands' });
  const items = await list.getByRole('option').allInnerTexts();
  if (items.length !== 6 || !/^\/meet/.test(items[0])) throw new Error(items.join('|'));
  await box().fill('/p');
  if ((await list.getByRole('option').count()) !== 1) throw new Error('not narrowed');
  await list.getByRole('option').click();
  if (await box().inputValue() !== '/poll ') throw new Error(await box().inputValue());
  const shot = await list.count();
  if (shot) throw new Error('list stays after a space');
});
await step('keyboard: ↓ moves through the list, Tab picks, Escape closes it', async () => {
  await box().fill('/');
  const list = page.getByRole('listbox', { name: 'Commands' });
  if (await list.getByRole('option', { selected: true }).innerText().then((t) => !t.startsWith('/meet'))) throw new Error('first not highlighted');
  await box().press('ArrowDown');
  if (!(await list.getByRole('option', { selected: true }).innerText()).startsWith('/poll')) throw new Error('down');
  await box().press('ArrowDown');
  await box().press('Tab');
  if (await box().inputValue() !== '/task ') throw new Error(await box().inputValue());
  await box().fill('/');
  await box().press('Escape');
  if (await list.count()) throw new Error('not closed');
  if (await box().inputValue() !== '/') throw new Error('text changed');
  await box().fill('');
});
await step('/poll makes a poll', async () => {
  await box().fill('/poll Lunch? | Pizza | Sushi');
  await box().press('Enter');
  await page.locator('.messages').getByText('Lunch?').waitFor();
  await page.locator('.messages').getByText('Sushi').waitFor();
  if (await box().inputValue() !== '') throw new Error('box not cleared');
});
await step('a /poll without options: an error, and the text stays', async () => {
  await box().fill('/poll Lunch?');
  await box().press('Enter');
  await page.getByText('Write it as /poll Question | option | option').waitFor();
  if (await box().inputValue() !== '/poll Lunch?') throw new Error('text lost');
  await box().fill('');
});
await step('/task adds a task to My tasks, linking back here', async () => {
  await box().fill('/task Book the venue');
  await box().press('Enter');
  await page.getByText(/^Added to /).first().waitFor();
  const { lists } = (await api(page, 'GET', '/tasks/lists')).body;
  const tasks = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const t = (tasks.tasks || tasks).find((x) => x.title === 'Book the venue');
  if (!t || !JSON.stringify(t).includes(`/chat/${general}`)) throw new Error(JSON.stringify(t));
});
await step('/meet starts a meeting, shared here; an unknown /word is sent as it is', async () => {
  await box().fill('/meet');
  const [tab] = await Promise.all([page.context().waitForEvent('page'), box().press('Enter')]);
  await tab.waitForURL(/\/meet\//);
  await tab.close();
  await page.locator('.messages').getByText(/Started a video meeting/).first().waitFor();
  await box().fill('/shrug');
  await box().press('Enter');
  await page.locator('.messages').getByText('/shrug', { exact: true }).waitFor();
});
await step('phone width: the list fits', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await box().fill('/');
  const b = await page.getByRole('listbox', { name: 'Commands' }).boundingBox();
  if (!b || b.x < 0 || b.x + b.width > 390) throw new Error(JSON.stringify(b));
  await page.screenshot({ path: `${SP}/shots/slash-phone.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
