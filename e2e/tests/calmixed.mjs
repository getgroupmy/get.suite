// Monthly on mixed weekdays (as Outlook and phones can write it): a calendar file with "the first Monday and the
// third Tuesday" comes in as that repeat (before, a one-off), shows on those days, says so, and renaming it in the
// web keeps it. And the web makes them too: in quick add, and by ticking days in Repeat.
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
let id;
await step('setup, and a calendar file with the first Monday and the third Tuesday', async () => {
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
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:board@x', `DTSTART;TZID=${tz}:20261102T180000`, `DTEND;TZID=${tz}:20261102T190000`, 'SUMMARY:Board',
    'RRULE:FREQ=MONTHLY;BYDAY=1MO,3TU', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'outlook.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  id = (await api('GET', `/events?from=${t0}&to=${t0 + 40 * 864e5}`)).body.find((e) => e.title === 'Board')?.id;
});

await step('November shows it on Monday the 2nd and Tuesday the 17th (and Monday 7 December)', async () => {
  await page.goto(`${B}/calendar`);
  const month = page.getByRole('button', { name: /^Month$/ }).first();
  if (await month.count()) await month.click();
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText('Board').first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Board' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  // November's grid runs to 12 December: Mon 2 and Tue 17 November, then Mon 7 December (the first Monday).
  if (JSON.stringify(cells) !== '["2","17","7"]') throw new Error(`shown on ${JSON.stringify(cells)}`);
});

await step('the event says so, and renaming it keeps the repeat', async () => {
  await page.getByText('Board').first().click();
  const dlg = page.getByRole('dialog').first();
  let sel = dlg.getByRole('combobox', { name: 'Repeat', exact: true });
  if (!(await sel.count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); sel = page.getByRole('dialog').first().getByRole('combobox', { name: 'Repeat', exact: true }); }
  const text = await sel.evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first Monday and the third Tuesday/.test(text)) throw new Error(`the repeat reads “${text}”`);
  const d2 = page.getByRole('dialog').first();
  await d2.getByLabel('Title').fill('Board meeting');
  await d2.getByRole('button', { name: 'Save' }).click();
  const all = page.getByRole('radio', { name: 'All events' });
  await all.waitFor({ timeout: 5000 });
  await all.check();
  await all.locator('xpath=ancestor::form').getByRole('button').last().click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.id === id);
  if (ev?.title !== 'Board meeting') throw new Error(`title: ${ev?.title}`);
  if (JSON.stringify(ev.rrule) !== JSON.stringify({ freq: 'monthly', mdays: [[1, 1], [3, 2]] })) throw new Error(`the repeat became ${JSON.stringify(ev.rrule)}`);
});
const saved = async (title) => {
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  for (let k = 0; k < 20; k++) {
    const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 120 * 864e5}`)).body.find((e) => e.title === title);
    if (ev) return ev;
    await page.waitForTimeout(250);
  }
  return null;
};
await step('quick add “Rota the first Monday and the last Friday 9am”: from Friday 27 November', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByLabel('Quick add an event').fill('Rota the first Monday and the last Friday 9am');
  await page.getByLabel('Quick add an event').press('Enter');
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Title').waitFor();
  if (await dlg.getByLabel('Title').inputValue() !== 'Rota') throw new Error(`title “${await dlg.getByLabel('Title').inputValue()}”`);
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first Monday and the last Friday/.test(text)) throw new Error(`the repeat reads “${text}”`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  const ev = await saved('Rota');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', mdays: [[1, 1], [-1, 5]] })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
  const st = await page.evaluate((t) => { const d = new Date(t); return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}`; }, ev.start);
  if (st !== '11-27 9') throw new Error(`starts ${st}`);
});
await step('a new event on Monday 7 December, Repeat → chosen days: tick the third Tuesday too', async () => {
  const start = await page.evaluate(() => new Date(2026, 11, 7, 14).getTime());
  const made = (await api('POST', '/events', { title: 'Clinic', start, end: start + 36e5 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  const next = page.getByRole('button', { name: /^Next/ }).first();
  for (let k = 0; k < 6 && !(await page.getByText('Clinic', { exact: true }).count()); k++) await next.click();
  await page.getByText('Clinic', { exact: true }).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('monthly-mdays');
  const grid = dlg.getByRole('group', { name: 'Which days of the month' });
  if (!(await grid.getByRole('checkbox', { name: 'First Monday' }).isChecked())) throw new Error('the start’s own day isn’t ticked');
  await grid.getByRole('checkbox', { name: 'Third Tuesday' }).check();
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first Monday and the third Tuesday/.test(text)) throw new Error(`the repeat reads “${text}”`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 120 * 864e5}`)).body.find((e) => e.id === made.id);
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', mdays: [[1, 1], [3, 2]] })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
