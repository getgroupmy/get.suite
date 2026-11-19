// Download your data has the calendars you subscribe to by address and your saved mail searches; Settings →
// Bring in your data… on another account subscribes again (the events fetched from the address) and saves the
// searches again, once each however many times it's brought in. With this machine's mail server (--mail).
import { chromium } from 'playwright';
import http from 'node:http';
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
const day = new Date(Date.now() + 2 * 864e5), next = new Date(day.getTime() + 864e5);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Office holidays', 'BEGIN:VEVENT', 'UID:o1@test', `DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(next)}`, 'SUMMARY:Founders Day', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(ics); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${srv.address().port}/office.ics`;

await step('setup: a calendar subscription and a saved search, then Download your data', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).first().click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 60000 });
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const f = await api('POST', '/events/feeds', { url: feed, name: 'Office holidays', color: '#0b8043' });
  if (f.status !== 201) throw new Error(JSON.stringify(f.body));
  const s = await api('POST', '/mail/searches', { name: 'Invoices', folder: 'INBOX', query: 'from:billing' });
  if (s.status !== 201) throw new Error(JSON.stringify(s.body));
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
  if (!zip.includes('Calendar subscriptions.json') || !zip.includes('saved searches.json')) throw new Error('not in the download');
});

await step('Kim brings it in: the summary says so, and the subscribed calendar shows its events', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /1 calendar subscription, 1 saved mail search/ }).first().waitFor({ timeout: 30000 });
  await page.goto(`${B}/calendar`);
  await page.getByRole('list', { name: 'Subscribed calendars' }).getByText('Office holidays').waitFor();
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Founders Day', { exact: true }).first().waitFor({ timeout: 15000 });
});

await step('brought in again: still one of each', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /^Brought in / }).nth(1).waitFor({ timeout: 30000 }).catch(() => page.waitForTimeout(3000));
  const feeds = (await api('GET', '/events/feeds')).body;
  if (feeds.length !== 1) throw new Error(`${feeds.length} subscriptions`);
  const s = (await api('GET', '/mail/searches')).body;
  const n = (s.searches || s).filter?.((x) => x.name === 'Invoices').length;
  if (n !== 1) throw new Error(`${n} saved searches: ${JSON.stringify(s).slice(0, 200)}`);
});
srv.close();
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
