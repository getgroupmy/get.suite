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
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sec = (name) => page.getByRole('region', { name });
await step('things for today', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const start = new Date(); start.setHours(23, 0, 0, 0);
  const { code } = (await api(page, 'POST', '/meet', { title: 'Late call' })).body;
  await api(page, 'POST', '/events', { title: 'Late call', start: start.getTime(), end: start.getTime() + 30 * 6e4, meet_code: code });
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Send invoice', due: iso(new Date()) });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board pack' });
  await api(page, 'POST', '/notes', { title: 'Wifi password', body: 'acme-guest', pinned: true });
  // A colleague writes to Olivia directly.
  const k = await mk('kim'); await signIn(k, 'kim@acme.com');
  const dm = (await api(k, 'POST', '/chat/dm', { user_id: (await api(page, 'GET', '/auth/me')).body.user.id })).body;
  if (dm?.id) await api(k, 'POST', `/chat/channels/${dm.id}/messages`, { body: 'Got a minute?', files: [] });
  void kim;
});
await step('Home shows the day', async () => {
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Olivia$/ }).waitFor();
  await sec("Today's events").getByText('Late call').waitFor();
  await sec("Today's events").getByRole('link', { name: 'Join Late call' }).waitFor();
  await sec('Tasks for today').getByText('Send invoice').waitFor();
  await sec('Recent files').getByText('Board pack').waitFor();
  await sec('Pinned notes').getByText('Wifi password').waitFor();
  await page.screenshot({ path: `${SP}/shots/home.png` });
});
await step('unread chat shows', async () => {
  await sec('Unread').getByText('Kim Park').waitFor();
});
await step('items open where they live', async () => {
  await sec('Tasks for today').getByRole('link', { name: 'Send invoice' }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await sec('Pinned notes').getByRole('button', { name: /Wifi password/ }).click();
  await page.getByRole('dialog', { name: 'Wifi password' }).waitFor();
});
await step('updates live when a task is done elsewhere', async () => {
  await page.goto(`${B}/home`);
  await sec('Tasks for today').getByText('Send invoice').waitFor();
  const t = (await api(page, 'GET', `/tasks/due?from=2000-01-01&to=${iso(new Date())}`)).body[0];
  await api(page, 'PATCH', `/tasks/tasks/${t.id}`, { done: true, today: iso(new Date()) });
  await sec('Tasks for today').getByText('Nothing in My Day or due today. 🎉').waitFor();
});
await step('phone width', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`scrolls sideways: ${w}`);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
