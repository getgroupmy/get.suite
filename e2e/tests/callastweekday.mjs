// The first or last weekday of the month (Outlook's BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1, for month-end reports and
// payroll): a calendar file with it comes in as that repeat (before, a one-off on its first date) and shows on the
// last working days; and Repeat → "Monthly on the last weekday" makes one.
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
await step('setup, and an Outlook file: the last weekday of every month', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.clock.setFixedTime(new Date(2026, 10, 10, 9));
  await page.goto(`${B}/calendar`);
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:pay@x', `DTSTART;TZID=${tz}:20260731T160000`, `DTEND;TZID=${tz}:20260731T170000`, 'SUMMARY:Payroll',
    'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'outlook.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2026, 6, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 200 * 864e5}`)).body.find((e) => e.title === 'Payroll');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', setpos: -1, setdays: [1, 2, 3, 4, 5] })) throw new Error(`came in as ${JSON.stringify(ev?.rrule)}`);
});
await step('November shows it on Monday the 30th, and it says "Monthly on the last weekday"', async () => {
  await page.goto(`${B}/calendar`);
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText(/^Payroll/).first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Payroll' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (JSON.stringify(cells) !== '["30"]') throw new Error(`shown on ${JSON.stringify(cells)}`); // (the grid runs 1 November to 12 December)
  await page.getByText(/^Payroll/).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (text !== 'Monthly on the last weekday') throw new Error(`the repeat reads “${text}”`);
  await page.keyboard.press('Escape');
});
await step('a new event: Repeat → Monthly on the first weekday', async () => {
  const start = await page.evaluate(() => new Date(2026, 11, 1, 10).getTime());
  const made = (await api('POST', '/events', { title: 'Month opening', start, end: start + 36e5 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  const next = page.getByRole('button', { name: /^Next/ }).first();
  for (let k = 0; k < 6 && !(await page.getByText('Month opening', { exact: true }).count()); k++) await next.click();
  await page.getByText('Month opening', { exact: true }).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('monthly-firstweekday');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 120 * 864e5}`)).body.find((e) => e.id === made.id);
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', setpos: 1, setdays: [1, 2, 3, 4, 5] })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
