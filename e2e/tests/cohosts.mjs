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
let url, visitor;
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
await step('a booking page shared with a colleague (co-host)', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'New booking page' }).click();
  await dlg.getByLabel('Title').fill('Sales demo');
  for (const d of ['Sun', 'Sat']) await dlg.getByLabel(d, { exact: true }).check();
  await dlg.getByLabel('From', { exact: true }).fill('00:00');
  await dlg.getByLabel('To', { exact: true }).fill('23:30');
  await dlg.getByLabel('At least this much notice').selectOption({ label: 'None' });
  await dlg.getByLabel('Add a co-host').fill('kim');
  await dlg.getByRole('list', { name: 'Colleagues to add' }).getByRole('button', { name: /Kim Park/ }).click();
  await dlg.getByRole('list', { name: 'Co-hosts' }).getByText('Kim Park').waitFor();
  await dlg.screenshot({ path: `${SP}/shots/booking-cohosts.png` });
  await dlg.getByRole('button', { name: 'Create' }).click();
  await dlg.getByText(/with Kim Park/).waitFor();
  url = (await api(page, 'GET', '/bookings')).body[0].url;
  await page.keyboard.press('Escape');
});
await step('the visitor books "Olivia Owner or Kim Park"; Olivia is busy, so it goes on Kim\'s calendar', async () => {
  // Olivia is busy for the next two days.
  const now = Date.now();
  await api(page, 'POST', '/events', { title: 'Offsite', start: now, end: now + 3 * 864e5 });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const visitor = await ctx.newPage();
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByText('Book time with Olivia Owner or Kim Park').waitFor();
  await visitor.getByRole('tab').nth(1).click();
  await visitor.getByRole('group', { name: /^Times on/ }).getByRole('button').first().click();
  await visitor.getByLabel('Your name').fill('Oscar Out');
  await visitor.getByLabel('Your email').fill('oscar@example.org');
  await visitor.getByRole('button', { name: /^Book/ }).click();
  await visitor.getByText(/Kim Park/).first().waitFor();
  await ctx.close();
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const evs = (await api(kim, 'GET', `/events?from=${now}&to=${now + 4 * 864e5}`)).body;
  if (!evs.some((e) => e.title === 'Sales demo: Oscar Out')) throw new Error(JSON.stringify(evs.map((e) => e.title)));
  const bell = (await api(kim, 'GET', '/notifications')).body.items;
  if (!bell.some((n) => n.title === 'Oscar Out booked “Sales demo”')) throw new Error('Kim not told');
  const hers = (await api(page, 'GET', `/events?from=${now}&to=${now + 4 * 864e5}`)).body;
  if (hers.some((e) => e.title === 'Sales demo: Oscar Out')) throw new Error('on Olivia\'s calendar too');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
