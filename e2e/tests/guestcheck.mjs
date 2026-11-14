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
await step('event window: an invited colleague busy then, or for whom it is outside their working hours, is named', async () => {
  for (const [local, name] of [['kim', 'Kim Tokyo'], ['cy', 'Cy Busy']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(`user ${r.status}`);
  }
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await api(kim, 'PUT', '/users/me/work-hours', { hours: { days: [0, 1, 2, 3, 4, 5, 6], start: 9 * 60, end: 17 * 60, tz: 'Asia/Tokyo' } });
  const cy = await mk('cy'); await signIn(cy, 'cy@acme.com');
  // Cy is busy all of tomorrow, 12:00–18:00 UTC.
  const t = new Date(); t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(12, 0, 0, 0);
  await api(cy, 'POST', '/events', { title: 'Offsite', start: t.getTime(), end: t.getTime() + 6 * 36e5 });
  await page.goto(B + '/calendar');
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Planning');
  const ymd = t.toISOString().slice(0, 10);
  await dlg.getByLabel('Starts').fill(ymd);
  await dlg.getByLabel('Start time').fill('14:00');
  await dlg.getByLabel('Ends').fill(ymd);
  await dlg.getByLabel('End time').fill('15:00');
  for (const who of ['kim@acme.com', 'cy@acme.com']) {
    await dlg.getByRole('combobox', { name: 'Guests' }).fill(who);
    await dlg.getByRole('combobox', { name: 'Guests' }).press('Enter');
  }
  const check = dlg.getByRole('list', { name: 'Guests at this time' });
  await check.getByText('Kim Tokyo').waitFor({ timeout: 10000 });
  await check.getByText('23:00–00:00 for them, outside their working hours').waitFor();
  await check.getByText('busy then').waitFor();
  await page.screenshot({ path: `${SP}/shots/guest-check.png` });
  // An hour that suits both: 01:00 UTC is 10:00 in Tokyo, and Cy is free.
  await dlg.getByLabel('Start time').fill('01:00');
  await dlg.getByLabel('End time').fill('02:00');
  await check.waitFor({ state: 'detached', timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
