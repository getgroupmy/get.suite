// Your own settings go into Download your data (Settings.json) and come back with it: chosen in Settings on one
// account (OpenDocument downloads) and in Calendar (working hours), brought into another, they're set there too.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let zip;

await step('setup: OpenDocument downloads and working hours chosen, then Download your data', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/settings`);
  await page.getByRole('radio', { name: /^OpenDocument/ }).check();
  await page.getByText('Files will download as OpenDocument').waitFor();
  await api('PUT', '/users/me/work-hours', { hours: { days: [1, 2, 3, 4], start: 480, end: 960, tz: 'Europe/Berlin' } });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Download your data/ }).first().click()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
  if (!zip.includes('Settings.json')) throw new Error('no Settings.json');
});

await step('Kim brings it in: the summary counts the settings, and Settings shows OpenDocument chosen', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  if (await page.getByRole('radio', { name: /^OpenDocument/ }).isChecked()) throw new Error('OpenDocument already chosen before');
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /\d+ settings?\b/ }).first().waitFor({ timeout: 30000 });
  await page.reload();
  await page.getByRole('radio', { name: /^OpenDocument/ }).waitFor();
  if (!(await page.getByRole('radio', { name: /^OpenDocument/ }).isChecked())) throw new Error('OpenDocument isn’t chosen');
  const h = (await api('GET', '/users/me/work-hours')).body;
  if (JSON.stringify([h.days, h.start, h.end, h.tz]) !== JSON.stringify([[1, 2, 3, 4], 480, 960, 'Europe/Berlin'])) throw new Error(JSON.stringify(h));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
