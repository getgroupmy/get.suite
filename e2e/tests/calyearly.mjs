// Yearly on a weekday of a month (holiday calendars: BYMONTH=5;BYDAY=-1MO, the last Monday of May; the fourth Thursday
// of November): a calendar file with it comes in as that repeat (before, a one-off on its first date), and Repeat in
// an event offers "Yearly on the fourth Thursday of November" from its date.
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
await step('setup, and a holiday calendar file: the last Monday of May, every year', async () => {
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
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:mem@x', 'DTSTART;VALUE=DATE:20270531', 'DTEND;VALUE=DATE:20270601', 'SUMMARY:Spring holiday',
    'RRULE:FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'outlook.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2027, 4, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 200 * 864e5}`)).body.find((e) => e.title === 'Spring holiday');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'yearly', nth: -1, wd: 1, month: 4 })) throw new Error(`came in as ${JSON.stringify(ev?.rrule)}`);
});
await step('May 2028 shows it on Monday the 29th, and it says "Yearly on the last Monday of May"', async () => {
  await page.clock.setFixedTime(new Date(2028, 4, 10, 9));
  await page.goto(`${B}/calendar`);
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText(/^Spring holiday/).first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Spring holiday' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (JSON.stringify(cells) !== '["29"]') throw new Error(`shown on ${JSON.stringify(cells)}`);
  await page.getByText(/^Spring holiday/).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (text !== 'Yearly on the last Monday of May') throw new Error(`the repeat reads “${text}”`);
  await page.keyboard.press('Escape');
  await page.clock.setFixedTime(new Date(2026, 10, 10, 9));
});
await step('a new event on Thursday 26 November: Repeat → Yearly on the fourth Thursday of November', async () => {
  const start = await page.evaluate(() => new Date(2026, 10, 26, 12).getTime());
  const made = (await api('POST', '/events', { title: 'Thanksgiving lunch', start, end: start + 36e5 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  const next = page.getByRole('button', { name: /^Next/ }).first();
  for (let k = 0; k < 6 && !(await page.getByText('Thanksgiving lunch', { exact: true }).count()); k++) await next.click();
  await page.getByText('Thanksgiving lunch', { exact: true }).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  const sel = dlg.getByRole('combobox', { name: 'Repeat', exact: true });
  const label = await sel.locator('option[value="yearly-nth"]').innerText();
  if (label !== 'Yearly on the fourth Thursday of November') throw new Error(`the choice reads “${label}”`);
  await sel.selectOption('yearly-nth');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 60 * 864e5}`)).body.find((e) => e.id === made.id);
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'yearly', nth: 4, wd: 4, month: 10 })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
