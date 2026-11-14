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
const day = 864e5;
const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
let oliviaId;
await step('Out of office… in the sidebar: an all-day time off with a message, no guests', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  oliviaId = (await api(page, 'GET', '/auth/me')).body?.id || (await api(page, 'GET', '/users/me')).body?.id;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Out of office…' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  if ((await d.getByLabel('Title').inputValue()) !== 'Out of office') throw new Error('title');
  if (!(await d.getByLabel('Out of office').isChecked())) throw new Error('ticked');
  if (await d.getByText('Guests', { exact: true }).count()) throw new Error('no guests for time off');
  await d.getByLabel('Ends').fill(iso(new Date(dayStart + 2 * day)));
  await d.getByLabel('Message for people who invite you').fill('On holiday until Wednesday');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.locator('.month .chip.ooo', { hasText: 'Out of office' }).first().waitFor();
  await page.screenshot({ path: `${SP}/shots/ooo-month.png` });
});
await step('Kim invites Olivia during it: declined for her, Kim is told why', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const start = dayStart + day + 10 * 36e5;
  const r = await api(kim, 'POST', '/events', { title: 'Design review', start, end: start + 36e5, guests: ['olivia@acme.com'] });
  if (r.body.guests[0].status !== 'no') throw new Error(JSON.stringify(r.body.guests));
  const bell = (await api(kim, 'GET', '/notifications')).body.items;
  if (!bell.some((n) => n.title === 'Olivia Owner is out of office and declined “Design review”' && n.body === 'On holiday until Wednesday')) throw new Error(JSON.stringify(bell));
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Month' }).click();
  await kim.locator('.month .chip', { hasText: 'Design review' }).first().click();
  await kim.getByRole('dialog', { name: 'Edit event' }).getByText('1 guest: 1 no').waitFor();
});
await step("in Kim's view of Olivia's calendar, the time shows as out of office", async () => {
  await kim.keyboard.press('Escape');
  await kim.getByRole('combobox', { name: "Show a colleague's calendar" }).selectOption({ label: 'Olivia Owner' });
  await kim.getByRole('radio', { name: 'Day' }).click();
  await kim.getByLabel(/^Olivia Owner out of office /).first().waitFor();
  await kim.screenshot({ path: `${SP}/shots/ooo-busy.png` });
});
await step('editing it: untick Out of office and it is an ordinary event again', async () => {
  await page.locator('.month .chip.ooo', { hasText: 'Out of office' }).first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  if (!(await d.getByLabel('Out of office').isChecked())) throw new Error('ticked when opened');
  await d.getByLabel('Out of office').uncheck();
  await d.getByText('Guests', { exact: true }).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await page.locator('.month .chip.ooo').count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
