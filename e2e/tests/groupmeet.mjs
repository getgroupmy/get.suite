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
const kim = await mk('kim');
let ids = {}, busy;
await step('a group with Kim and Max; Kim busy first thing on the next working day', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['max', 'Max Meet']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  const g = await api(page, 'POST', '/contacts/groups', { name: 'Launch team', members: [{ name: 'Kim Park', email: 'kim@acme.com' }, { name: 'Max Meet', email: 'max@acme.com' }] });
  if (g.status !== 201) throw new Error(JSON.stringify(g.body));
  await signIn(kim, 'kim@acme.com');
  busy = await kim.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); });
  await api(kim, 'POST', '/events', { title: 'Kim busy', start: busy, end: busy + 3600e3 });
});
await step('Contacts → Groups → 📅: an event named after the group, everyone invited, at the first free hour', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('button', { name: 'Schedule a meeting with Launch team' }).click();
  await page.waitForURL(/\/calendar/);
  const expected = await page.evaluate(async (u) => (await (await fetch(`/api/freebusy/suggest?users=${u}&duration=60&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`)).json()).slots[0], `${ids.kim},${ids.max}`);
  if (expected.start < busy + 3600e3 && expected.end > busy) throw new Error('suggested while Kim is busy');
  const when = await page.evaluate((t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), expected.start);
  await page.getByText(`The first hour you’re all free: ${when}`).waitFor();
  const d = page.getByRole('dialog', { name: 'New event' });
  if (await d.getByLabel('Title').inputValue() !== 'Launch team') throw new Error('title');
  await d.getByText('Kim Park').first().waitFor();
  await d.getByText('Max Meet').first().waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
