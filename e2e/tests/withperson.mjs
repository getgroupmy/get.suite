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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('a colleague\'s card lists your meetings with them; one opens in Calendar', async () => {
  const t = Date.now() + 2 * 864e5;
  await api(page, 'POST', '/events', { title: 'Budget review with Kim', start: t, end: t + 36e5, guests: ['kim@acme.com'], tz: 'UTC' });
  await api(page, 'POST', '/events', { title: 'Kickoff with Kim', start: t - 9 * 864e5, end: t - 9 * 864e5 + 36e5, guests: ['kim@acme.com'], tz: 'UTC' });
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.locator('button.person-name', { hasText: 'Kim Park' }).first().click();
  const meetings = page.getByRole('region', { name: 'Meetings' });
  await meetings.getByRole('link', { name: 'Budget review with Kim' }).waitFor();
  await meetings.getByText(/^Next:/).waitFor();
  await meetings.getByRole('link', { name: 'Kickoff with Kim' }).waitFor();
  await meetings.getByRole('link', { name: 'Budget review with Kim' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Title' }).or(page.getByRole('dialog').getByText('Budget review with Kim')).first().waitFor();
});
await step('a contact\'s history shows the same', async () => {
  await api(page, 'POST', '/contacts', { name: 'Kim (personal)', email: 'kim@acme.com' });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'History with Kim (personal)' }).click();
  const d = page.getByRole('dialog', { name: 'With Kim (personal)' });
  await d.getByRole('link', { name: 'Budget review with Kim' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
