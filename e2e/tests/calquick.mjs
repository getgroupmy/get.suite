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
const quick = () => page.getByLabel('Quick add an event');
const said = () => page.locator('#cal-quick-what');
const dlg = () => page.getByRole('dialog', { name: 'New event' });
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
const range = async () => (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 60 * 864e5}`)).body;
await step('typing shows what is understood; Enter opens the event filled in; Save adds it', async () => {
  await page.goto(`${B}/calendar`);
  await quick().fill('Lunch with Kim tomorrow 1pm for 30m');
  await said().getByText('Lunch with Kim').waitFor();
  const text = await said().textContent();
  if (!/1:00\s?PM – 1:30\s?PM/.test(text)) throw new Error(text);
  await quick().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Lunch with Kim') throw new Error('title');
  if (await quick().inputValue() !== '') throw new Error('box not cleared');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  const e = (await range()).find((x) => x.title === 'Lunch with Kim');
  const s = new Date(e?.start);
  if (!e || s.getDate() !== tomorrow.getDate() || s.getHours() !== 13 || e.end - e.start !== 30 * 60e3) throw new Error(JSON.stringify(e));
});
await step('a repeat comes with it, shown in the event window', async () => {
  await quick().fill('1:1 with Ana every 2 weeks on tue 10am');
  await said().getByText(/Every 2 weeks on Tue/i).waitFor();
  await quick().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByRole('combobox', { name: 'Repeat', exact: true }).inputValue() !== 'weekly') throw new Error(await dlg().getByRole('combobox', { name: 'Repeat', exact: true }).inputValue());
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  const e = (await range()).find((x) => x.title === '1:1 with Ana');
  if (JSON.stringify(e?.rrule) !== JSON.stringify({ freq: 'weekly', interval: 2, byday: [2] }) || new Date(e.start).getDay() !== 2) throw new Error(JSON.stringify(e));
});
await step('a day alone is all day; a time range sets the end', async () => {
  const d = new Date(); d.setDate(d.getDate() + 20);
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  await quick().fill(`Company holiday ${iso}`);
  await said().getByText(/all day/).waitFor();
  await quick().press('Enter');
  await dlg().waitFor();
  if (!(await dlg().getByLabel('All day').isChecked())) throw new Error('not all day');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  await quick().fill(`Workshop ${iso} 3-5pm`);
  await said().getByText(/3:00\s?PM – 5:00\s?PM/).waitFor();
  await quick().press('Enter');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  const evs = await range();
  const h = evs.find((x) => x.title === 'Company holiday');
  const w = evs.find((x) => x.title === 'Workshop');
  if (!h?.all_day || w?.end - w?.start !== 2 * 36e5 || new Date(w.start).getHours() !== 15) throw new Error(JSON.stringify([h, w]));
});
await step('words with no day or time: a new event with that title; Escape-free, nothing saved until Save', async () => {
  await quick().fill('Think about the roadmap');
  await said().getByText('Add a day or time, like “tomorrow 3pm”').waitFor();
  await quick().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Think about the roadmap') throw new Error('title');
  await dlg().getByRole('button', { name: 'Cancel' }).click();
  if ((await range()).some((x) => x.title === 'Think about the roadmap')) throw new Error('saved');
  await page.screenshot({ path: `${SP}/shots/cal-quick.png` });
});
await step('phone width: the box fits', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await quick().scrollIntoViewIfNeeded();
  const b = await quick().boundingBox();
  if (!b || b.width < 150) throw new Error(JSON.stringify(b));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > 390) throw new Error(`page scrolls sideways: ${sw}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
