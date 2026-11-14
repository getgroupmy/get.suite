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
const nextDay = (() => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() % 6 === 0); return d; })();
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = isoOf(new Date());
await step('Kim works in the office; Lee at home, but in the office on the next working day', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Chan']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const all = (p) => ({ 0: p, 1: p, 2: p, 3: p, 4: p, 5: p, 6: p });
  for (const [who, place] of [['kim', 'office'], ['lee', 'home']]) {
    const p = await mk(who); await signIn(p, `${who}@acme.com`);
    await api(p, 'PUT', '/location/week', { week: all(place) });
    if (who === 'lee') await api(p, 'PUT', '/location/day', { date: isoOf(nextDay), place: 'office' });
    if (who === 'kim') await api(p, 'PUT', '/location/day', { date: todayIso, place: 'office' });
  }
});
await step('Directory: Today shows 1 in the office; the filter keeps only Kim', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  const strip = page.getByRole('group', { name: 'Who’s where' }).or(page.getByRole('group', { name: "Who's where" }));
  await until(async () => (await strip.getByRole('button', { name: /^Today/ }).innerText()).replace(/\s+/g, ' ').trim() === 'Today 🏢 1');
  await page.getByLabel('Where they are').selectOption('office');
  await until(async () => (await page.locator('table.files tbody tr').allInnerTexts()).length === 1);
  await page.locator('table.files tbody tr', { hasText: 'Kim Park' }).getByText('· 🏢 Office today').waitFor();
});
await step('the next working day: Lee comes in too', async () => {
  const strip = page.getByRole('group', { name: "Who's where" });
  const btn = strip.getByRole('button').nth(1);
  if (!(await btn.innerText()).includes('🏢 2')) throw new Error(await btn.innerText());
  await btn.click();
  await until(async () => (await page.locator('table.files tbody tr').allInnerTexts()).length === 2);
  const wd = nextDay.toLocaleDateString('en-US', { weekday: 'long' });
  await page.locator('table.files tbody tr', { hasText: 'Lee Chan' }).getByText(`· 🏢 Office on ${wd}`).waitFor();
  await page.screenshot({ path: `${SP}/shots/wheredays.png` });
  await page.getByLabel('Where they are').selectOption('none');
  await until(async () => (await page.locator('table.files tbody tr').allInnerTexts()).some((t) => t.includes('Olivia Owner')));
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
