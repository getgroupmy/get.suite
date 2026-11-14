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
const max = await mk('max');
await step('Home: ⏱ Late on today’s Standup tells Olivia; a solo event has none', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  const start = Date.now() + 10 * 60e3;
  await api(page, 'POST', '/events', { title: 'Standup', start, end: start + 15 * 60e3, guests: ['max@acme.com'] });
  await signIn(max, 'max@acme.com');
  await api(max, 'POST', '/events', { title: 'Focus block', start, end: start + 15 * 60e3 });
  await page.goto(`${B}/drive`);
  await max.goto(`${B}/home`);
  const today = max.getByRole('region', { name: "Today's events" });
  await today.getByText('Standup').waitFor();
  if (await today.getByRole('button', { name: 'Running late for Focus block' }).count()) throw new Error('solo event offered');
  await today.getByRole('button', { name: 'Running late for Standup' }).click();
  await max.getByRole('menuitem', { name: '15 minutes late', exact: true }).click();
  await max.getByText('Everyone on “Standup” knows you’re running 15 minutes late').waitFor();
  await page.getByText('⏱ Max Meet is running 15 minutes late for “Standup”').waitFor();
});
await step('the reminder before it: 5 min late, there and then', async () => {
  await page.waitForTimeout(500);
  const start = Date.now() + 70e3; // a reminder 1 minute before: due in about 10 seconds
  await api(page, 'POST', '/events', { title: 'Client call', start, end: start + 30 * 6e4, reminders: [1], guests: ['max@acme.com'] });
  await page.getByText('Client call starts in 1 minute').waitFor({ timeout: 40000 });
  await page.getByRole('button', { name: '5 min late', exact: true }).click();
  await page.getByText('Everyone on “Client call” knows you’re running 5 minutes late').waitFor();
  await max.getByText('⏱ Olivia Owner is running 5 minutes late for “Client call”').waitFor();
});
await step('an event with its own channel: Running late shows there, from Max', async () => {
  const start = Date.now() + 8 * 60e3;
  const ev = (await api(page, 'POST', '/events', { title: 'Design review', start, end: start + 15 * 60e3, guests: ['max@acme.com'] })).body;
  const ch = (await api(page, 'POST', `/events/${ev.id}/chat`)).body;
  await max.goto(`${B}/home`);
  const today = max.getByRole('region', { name: "Today's events" });
  await today.getByRole('button', { name: 'Running late for Design review' }).click();
  await max.getByRole('menuitem', { name: '10 minutes late', exact: true }).click();
  await max.getByText('Everyone on “Design review” knows you’re running 10 minutes late').waitFor();
  await page.goto(`${B}/chat/${ch.id}`);
  const msg = page.locator('.msg', { hasText: '⏱ Running 10 minutes late' }).first();
  await msg.waitFor();
  if (!/Max Meet/.test(await page.locator('.messages').innerText())) throw new Error('not from Max');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
