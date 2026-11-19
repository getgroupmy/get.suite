// Your calendars besides the main one (Family, a project…) go into Download your data, and Settings → Bring in your
// data… on another account brings them back as calendars of their own, each with its events (before, they all
// landed in the main calendar): hiding Family there hides its events.
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
const start = Date.now() + 2 * 864e5;

await step('setup: a Family calendar with an event, then Download your data', async () => {
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
  const fam = (await api('POST', '/events/calendars', { name: 'Family', color: '#8e24aa' })).body;
  await api('POST', '/events', { title: 'Grandma visit', start, end: start + 3600e3, calendar_id: fam.id });
  await api('POST', '/events', { title: 'Team standup', start, end: start + 1800e3 });
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
});

await step('Kim brings it in: Family is one of their calendars, with its event', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /2 events, 1 calendar\b/ }).first().waitFor({ timeout: 30000 });
  await page.goto(`${B}/calendar`);
  await page.getByRole('list', { name: 'My calendars' }).getByText('Family').waitFor();
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Grandma visit', { exact: true }).first().waitFor();
});

await step('hiding Family hides its event, not the main calendar’s', async () => {
  await page.getByRole('checkbox', { name: 'Show Family' }).uncheck();
  await page.getByText('Grandma visit', { exact: true }).first().waitFor({ state: 'detached' });
  await page.getByText('Team standup', { exact: true }).first().waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
