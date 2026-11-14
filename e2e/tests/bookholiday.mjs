import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let url, date;
await step('a booking page for every weekday', async () => {
  const made = await api(page, 'POST', '/bookings', { title: 'Office hours', duration: 60, days: [1, 2, 3, 4, 5], from_min: 540, to_min: 1020, tz: 'UTC', days_ahead: 14, notice_hours: 0 });
  if (made.status !== 201) throw new Error(JSON.stringify(made));
  url = made.body.url.replace(/^https?:\/\/[^/]+/, B);
  const d = new Date(Date.now() + 3 * 864e5);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  date = d.toISOString().slice(0, 10);
});
const visit = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(url);
  await v.getByRole('heading', { name: 'Office hours' }).waitFor();
  const days = (await v.evaluate(async (t) => (await (await fetch(`/api/public/book/${t}`)).json()).days.map((x) => x.date), url.split('/b/')[1]));
  return { v, days, tabs: await v.getByRole('tab').count() };
};
await step('a company holiday: visitors aren\'t offered that day', async () => {
  const before = await visit();
  if (!before.days.includes(date)) throw new Error(`${date} not open at first`);
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  const hol = dlg.getByRole('region', { name: 'Company holidays' });
  await hol.getByLabel('Holiday').fill(date);
  await hol.getByLabel('Name').fill('Founders Day');
  await hol.getByRole('button', { name: 'Add holiday' }).click();
  await page.getByText('Founders Day added').waitFor();
  const after = await visit();
  if (after.days.includes(date)) throw new Error('still offered');
  if (after.days.length !== before.days.length - 1) throw new Error(`${after.days.length} vs ${before.days.length}`);
  if (after.tabs >= before.tabs) throw new Error(`tabs ${after.tabs} vs ${before.tabs}`);
  await after.v.screenshot({ path: `${SP}/shots/booking-holiday.png` });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
