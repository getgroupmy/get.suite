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
await step('the admin adds rooms in Company settings', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click().catch(() => page.getByRole('button', { name: 'Company settings' }).click());
  await page.getByLabel('New room name').fill('Boardroom');
  await page.getByLabel('Seats', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByText('Room added').waitFor();
  await page.getByLabel('New room name').fill('Small room');
  await page.getByRole('button', { name: 'Add room' }).click();
  await page.getByRole('list', { name: 'Rooms' }).getByLabel('Name of Small room').waitFor();
});
await step('Olivia books the boardroom for tomorrow at 10', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByLabel('Title').fill('Board meeting');
  await d.getByLabel('Starts').fill(dayIso(tomorrowAt(10)));
  await d.getByLabel('Start time').fill('10:00');
  await d.getByLabel('Ends').fill(dayIso(tomorrowAt(10)));
  await d.getByLabel('End time').fill('12:00');
  await d.getByLabel('Add a room').selectOption({ label: 'Boardroom (12) — free' });
  await d.getByRole('list', { name: 'Rooms' }).getByText('Free: booked when you save').waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  const ev = (await api(page, 'GET', `/events?from=${tomorrowAt(0)}&to=${tomorrowAt(23)}`)).body.find((e) => e.title === 'Board meeting');
  if (ev?.rooms?.[0]?.status !== 'yes') throw new Error(JSON.stringify(ev?.rooms));
});
await step('for Kim at 11 the boardroom shows as taken; the small room is booked instead', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('button', { name: 'Create' }).click();
  const d = kim.getByRole('dialog', { name: 'New event' });
  await d.getByLabel('Title').fill('Interview');
  await d.getByLabel('Starts').fill(dayIso(tomorrowAt(11)));
  await d.getByLabel('Start time').fill('11:00');
  await d.getByLabel('Ends').fill(dayIso(tomorrowAt(11)));
  await d.getByLabel('End time').fill('12:00');
  await d.getByLabel('Add a room').locator('option', { hasText: 'Boardroom (12) — taken then' }).waitFor({ state: 'attached' });
  await d.getByLabel('Add a room').selectOption({ label: 'Small room — free' });
  await kim.screenshot({ path: `${SP}/shots/rooms.png` });
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
});
await step('Kim looks at the boardroom’s bookings beside her calendar: the board meeting, with who booked it', async () => {
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('combobox', { name: "Show a room's bookings" }).selectOption({ label: 'Boardroom' });
  await kim.getByRole('radio', { name: 'Day' }).click();
  await kim.getByRole('button', { name: /^Next/ }).click();
  await kim.getByLabel(/^Boardroom booked: Board meeting by Olivia Owner/).waitFor();
  await kim.screenshot({ path: `${SP}/shots/room-bookings.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
