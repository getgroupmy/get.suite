// A weekday counted from the end of the month (BYDAY=-2MO, the second-to-last Monday), from a phone or Outlook: it
// comes in as that repeat (before, a one-off on its first date), shows on those Mondays, says so, and renaming it
// keeps it.
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
await step('setup, and a phone file: the second-to-last Monday of every month', async () => {
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
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rev@x', `DTSTART;TZID=${tz}:20261123T160000`, `DTEND;TZID=${tz}:20261123T170000`, 'SUMMARY:Review',
    'RRULE:FREQ=MONTHLY;BYDAY=-2MO', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'outlook.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2026, 6, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 200 * 864e5}`)).body.find((e) => e.title === 'Review');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', nth: -2, wd: 1 })) throw new Error(`came in as ${JSON.stringify(ev?.rrule)}`);
});
await step('November shows it on Monday the 23rd; it says "Monthly on the second-to-last Monday"; renamed, it stays', async () => {
  await page.goto(`${B}/calendar`);
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText(/^Review/).first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Review' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (JSON.stringify(cells) !== '["23"]') throw new Error(`shown on ${JSON.stringify(cells)}`); // (Mondays 2, 9, 16, 23, 30; the grid ends 12 December)
  await page.getByText(/^Review/).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (text !== 'Monthly on the second-to-last Monday') throw new Error(`the repeat reads “${text}”`);
  await dlg.getByLabel('Title').fill('Monthly review');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const all = page.getByRole('radio', { name: 'All events' });
  await all.waitFor({ timeout: 5000 });
  await all.check();
  await all.locator('xpath=ancestor::form').getByRole('button').last().click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.title === 'Monthly review');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', nth: -2, wd: 1 })) throw new Error(`the repeat became ${JSON.stringify(ev?.rrule)}`);
});
await step('BYDAY=3MO;BYSETPOS=2 (the second of a set of one: no dates) comes in as a one-off, not as every third Monday', async () => {
  await page.goto(`${B}/calendar`);
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:odd@x', `DTSTART;TZID=${tz}:20261124T100000`, `DTEND;TZID=${tz}:20261124T110000`, 'SUMMARY:Odd rule',
    'RRULE:FREQ=MONTHLY;BYDAY=3MO;BYSETPOS=2;COUNT=5', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'odd.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.title === 'Odd rule');
  if (!ev || ev.rrule !== null) throw new Error(`came in as ${JSON.stringify(ev?.rrule)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
