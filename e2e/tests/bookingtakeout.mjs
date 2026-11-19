// Download your data has your booking pages; Settings → Bring in your data… on another account brings each back
// with its settings and a new link (a page already there by that name isn't doubled).
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
let zip, mine;

await step('setup: a booking page, then Download your data', async () => {
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
  mine = (await api('POST', '/bookings', { title: 'Consultation', description: 'Talk through your plans', duration: 60, days: [1, 3, 5], from_min: 780, to_min: 1020, tz: 'Europe/Paris',
    notice_hours: 48, days_ahead: 21, questions: [{ label: 'What would you like to discuss?', required: true }], where_kind: 'video' })).body;
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
  if (!zip.includes('Booking pages.json')) throw new Error('no Booking pages.json in the download');
});

await step('Kim brings it in from Settings: the summary says so, and the page is there with a new link', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /1 booking page \(with new links\)/ }).first().waitFor({ timeout: 30000 });
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Booking pages/ }).first().click();
  await page.getByText('Consultation').first().waitFor();
  const theirs = ((await api('GET', '/bookings')).body.pages || (await api('GET', '/bookings')).body).find((p) => p.title === 'Consultation');
  const pick = (p) => JSON.stringify([p.description, p.duration, p.days, p.from_min, p.to_min, p.tz, p.notice_hours, p.days_ahead, p.questions, p.where_kind]);
  if (pick(theirs) !== pick(mine)) throw new Error(`${pick(theirs)} vs ${pick(mine)}`);
  if (theirs.url === mine.url) throw new Error('the same link');
});

await step('brought in again: still one', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /^Brought in / }).nth(0).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  const b = (await api('GET', '/bookings')).body;
  const n = (b.pages || b).filter((p) => p.title === 'Consultation').length;
  if (n !== 1) throw new Error(`${n} pages`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
