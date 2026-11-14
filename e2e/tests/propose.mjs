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
let evId, day;
await step('a guest proposes a new time', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  day = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); });
  evId = (await api(page, 'POST', '/events', { title: 'Review', start: day + 9 * 36e5, end: day + 10 * 36e5, guests: ['kim@acme.com'] })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Schedule' }).click();
  await kim.getByText('Review', { exact: true }).first().click();
  const d = kim.getByRole('dialog', { name: 'Review' });
  await d.getByRole('button', { name: 'Propose a new time' }).click();
  await d.getByLabel('From').fill('14:00');
  await d.getByLabel('To', { exact: true }).fill('15:00');
  await d.getByLabel('Note to the organizer (optional)').fill('Morning is full');
  await d.getByRole('button', { name: 'Propose', exact: true }).click();
  await kim.getByText('New time proposed to the organizer').waitFor();
}, kim);
await step('the organizer sees it and uses it; the proposal goes', async () => {
  const bell = (await api(page, 'GET', '/notifications')).body;
  if (!JSON.stringify(bell).includes('Kim Park proposed a new time for “Review”')) throw new Error('not told');
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Review', { exact: true }).first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByText('Morning is full').waitFor();
  await d.getByRole('button', { name: 'Use this time' }).click();
  if ((await d.getByLabel('Start time').inputValue()) !== '14:00') throw new Error('start not set');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  const ev = (await api(page, 'GET', `/events?from=${day}&to=${day + 864e5}`)).body.find((e) => e.id === evId);
  if (ev.start !== day + 14 * 36e5) throw new Error('not moved');
  if (ev.guests[0].proposed_start) throw new Error('proposal kept');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
