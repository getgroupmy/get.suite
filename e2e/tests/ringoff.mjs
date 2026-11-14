import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
const videoPlaying = (p, name) => p.evaluate((n) => { const v = document.querySelector(`video[aria-label="Video of ${n}"]`); return !!v && v.videoWidth > 0 && v.readyState >= 2; }, name);
let kim;
await step('Kim turns call pop-ups off in Settings', async () => {
  setTimeout(() => {}, 0);
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/settings`);
  await kim.getByRole('heading', { name: 'Calls' }).waitFor();
  await kim.getByRole('heading', { name: 'Calls' }).scrollIntoViewIfNeeded();
  await kim.locator('section', { hasText: 'Show calls on screen' }).getByRole('checkbox').uncheck();
  await kim.getByText('Calls only reach your notifications').waitFor();
  await kim.getByRole('region', { name: 'Calls' }).or(kim.locator('section', { hasText: 'Show calls on screen' })).first().screenshot({ path: `${SP}/shots/ringoff.png` });
  await kim.goto(`${B}/drive`);
}, kim);
await step('Olivia calls: nothing pops up for Kim, but it’s in her bell', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.locator('button.person-name', { hasText: 'Kim Park' }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('dialog', { name: 'Kim Park' }).getByRole('button', { name: 'Call' }).click();
  await (await popup).close();
  await kim.getByRole('button', { name: /^Notifications, \d+ new$/ }).waitFor({ timeout: 15000 });
  await kim.waitForTimeout(1500);
  if (await kim.getByText('📞 Olivia Owner is calling you').count() !== 0) {
    // only the bell panel may hold it (not opened yet): there must be no toast on screen
    if (await kim.locator('.toast', { hasText: 'is calling you' }).count()) throw new Error('popped up');
  }
  await kim.getByRole('button', { name: /^Notifications, \d+ new$/ }).click();
  await kim.getByRole('dialog', { name: 'Notifications' }).getByText('📞 Olivia Owner is calling you').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
