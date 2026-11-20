// All-day repeats made in a browser east of the server's clock (Kuala Lumpur, the server on UTC): the event's calendar
// file starts on the right day. Weekly on Monday from Sunday 6 December starts Monday the 7th; monthly on the second
// Monday, Monday the 14th (before, a day late: midnight there is still the day before on the server's clock).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Kuala_Lumpur' });
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
const fileOf = async (title, rrule) => {
  const [start, end] = await page.evaluate(() => [new Date(2026, 11, 6).getTime(), new Date(2026, 11, 7).getTime() - 1]);
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone); // sent with each event, as the web does
  const made = await api('POST', '/events', { title, start, end, all_day: 1, rrule, tz });
  if (made.status !== 201) throw new Error(`${made.status} ${JSON.stringify(made.body)}`);
  return page.evaluate(async (i) => (await fetch(`/api/events/${i}/ics`, { headers: { 'x-requested-with': 'nas-workspace' } })).text(), made.body.id);
};
await step('weekly on Monday, from Sunday 6 December: the file starts Monday 7 December', async () => {
  const ics = await fileOf('Gym', { freq: 'weekly', byday: [1], count: 3 });
  if (!/DTSTART;VALUE=DATE:20261207\r\n/.test(ics)) throw new Error(`the file has ${(ics.match(/DTSTART.*/) || ['no DTSTART'])[0]}`);
});
await step('monthly on the second Monday, from Sunday 6 December: the file starts Monday 14 December', async () => {
  const ics = await fileOf('Review', { freq: 'monthly', nth: 2, wd: 1, count: 3 });
  if (!/DTSTART;VALUE=DATE:20261214\r\n/.test(ics)) throw new Error(`the file has ${(ics.match(/DTSTART.*/) || ['no DTSTART'])[0]}`);
});
await step('and the calendar shows the Gym on Monday 7 December', async () => {
  await page.clock.setFixedTime(new Date(2026, 11, 2, 9));
  await page.goto(`${B}/calendar`);
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText('Gym').first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Gym' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (JSON.stringify(cells) !== '["7","14","21"]') throw new Error(`shown on ${JSON.stringify(cells)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
