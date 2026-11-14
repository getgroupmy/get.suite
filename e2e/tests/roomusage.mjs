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
const tomorrowAt = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.getTime(); };
const dayIso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
await step('rooms with some bookings over the past days', async () => {
  const ids = {};
  for (const name of ['Boardroom', 'Huddle', 'Storeroom']) ids[name] = (await api(page, 'POST', '/rooms', { name })).body.id;
  const back = (d, h) => Date.now() - d * 864e5 + h * 36e5;
  await api(page, 'POST', '/events', { title: 'Board', start: back(3, 0), end: back(3, 4), rooms: [ids.Boardroom] });
  await api(page, 'POST', '/events', { title: 'Plan', start: back(20, 0), end: back(20, 2), rooms: [ids.Boardroom] });
  await api(page, 'POST', '/events', { title: 'Sync', start: back(2, 0), end: back(2, 1), rooms: [ids.Huddle] });
});
await step('Admin sees usage, busiest first; a longer look back counts more', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click().catch(() => page.getByRole('button', { name: 'Company settings' }).click());
  const t = page.getByRole('table', { name: 'Room usage' });
  const rows = async () => (await t.locator('tbody tr').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
  await until(async () => (await rows()).length === 3);
  const r = await rows();
  if (!/^Boardroom 2 6 \d+% — Olivia Owner \(2\)$/.test(r[0]) || !/^Huddle 1 1 /.test(r[1]) || !/^Storeroom 0 0 0% — —$/.test(r[2])) throw new Error(r.join(' / '));
  await t.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/roomusage.png` });
  await page.getByLabel('Usage over').selectOption('7');
  await until(async () => /^Boardroom 1 4 10% /.test((await rows())[0] || ''));
});
await step('a no-show in a room with check-in is counted (the server releases it within a minute)', async () => {
  const id = (await api(page, 'POST', '/rooms', { name: 'Studio', check_in: true })).body.id;
  await api(page, 'POST', '/events', { title: 'Forgotten', start: Date.now() - 20 * 6e4, end: Date.now() + 40 * 6e4, rooms: [id] });
  await page.getByLabel('Usage over').selectOption('30');
  await until(async () => { const r = (await api(page, 'GET', '/rooms/usage?days=30')).body.rooms.find((x) => x.name === 'Studio'); return r?.no_shows === 1; }, 75000);
  await page.getByLabel('Usage over').selectOption('7');
  await page.getByLabel('Usage over').selectOption('30');
  const t = page.getByRole('table', { name: 'Room usage' });
  await until(async () => /^Studio 0 0 0% 1 —$/.test(((await t.locator('tbody tr', { hasText: 'Studio' }).innerText()) || '').replace(/\s+/g, ' ').trim()));
  await t.screenshot({ path: `${SP}/shots/roomusage-noshow.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
