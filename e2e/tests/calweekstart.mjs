// Every other week on Sunday and Monday, from a phone or Outlook: RFC 5545 counts weeks from Monday unless the rule
// says otherwise, so Sunday ends a week. The calendar shows the dates the phone does (before, it put the Monday
// straight after each Sunday), keeps that when the event is renamed, and writes WKST=MO back out.
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
await step('setup, and a calendar file: every other week on Sunday and Monday, from Sunday 8 November', async () => {
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
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rota@x', `DTSTART;TZID=${tz}:20261108T180000`, `DTEND;TZID=${tz}:20261108T190000`, 'SUMMARY:Rota',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'phone.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('1 event imported').waitFor();
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 40 * 864e5}`)).body.find((e) => e.title === 'Rota');
  id = ev?.id;
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'weekly', interval: 2, byday: [0, 1], wkst: 1 })) throw new Error(`came in as ${JSON.stringify(ev?.rrule)}`);
});

const shownOn = async () => {
  await page.goto(`${B}/calendar`);
  const mr = page.getByRole('radio', { name: 'Month' });
  if (await mr.count()) await mr.click();
  await page.getByText(/^Rota/).first().waitFor({ timeout: 8000 });
  return (await page.locator('.month').first().locator(':scope > *', { hasText: 'Rota' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
};
await step('November shows it on Sun 8, Mon 16, Sun 22, Mon 30 and Sun 6 December (not Mon 9 and Mon 23)', async () => {
  // November's grid runs from Sunday 1 November to Saturday 12 December.
  const cells = await shownOn();
  if (JSON.stringify(cells) !== '["8","16","22","30","6"]') throw new Error(`shown on ${JSON.stringify(cells)}`);
});

await step('renaming it keeps the weeks, and its calendar file says WKST=MO', async () => {
  await page.getByText(/^Rota/).first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByLabel('Title').count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  await dlg.getByLabel('Title').fill('Rota (phones)');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const all = page.getByRole('radio', { name: 'All events' });
  await all.waitFor({ timeout: 5000 });
  await all.check();
  await all.locator('xpath=ancestor::form').getByRole('button').last().click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.id === id);
  if (ev?.title !== 'Rota (phones)') throw new Error(`title: ${ev?.title}`);
  if (JSON.stringify(ev.rrule) !== JSON.stringify({ freq: 'weekly', interval: 2, byday: [0, 1], wkst: 1 })) throw new Error(`the repeat became ${JSON.stringify(ev.rrule)}`);
  const cells = await shownOn();
  if (JSON.stringify(cells) !== '["8","16","22","30","6"]') throw new Error(`now shown on ${JSON.stringify(cells)}`);
  const ics = await page.evaluate(async (i) => (await fetch(`/api/events/${i}/ics`, { headers: { 'x-requested-with': 'nas-workspace' } })).text(), id);
  if (!/RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO/.test(ics)) throw new Error(`the file has ${(ics.match(/RRULE:.*/) || ['no RRULE'])[0]}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
