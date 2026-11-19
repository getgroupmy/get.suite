// The first and third Monday of each month (as phones make it): both show, the event says so, and changing
// the event in the web (its title) keeps the repeat as it is.
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
await step('setup: a committee on the first and third Monday, from 2 November 2026', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const start = await page.evaluate(() => new Date(2026, 10, 2, 18).getTime());
  const r = await api('POST', '/events', { title: 'Committee', start, end: start + 7200e3, rrule: { freq: 'monthly', nths: [1, 3], wd: 1 } });
  if (r.status >= 300) throw new Error(`event: ${r.status} ${JSON.stringify(r.body)}`);
  id = r.body.id;
});

await step('November shows it on the 2nd and the 16th', async () => {
  await page.clock.setFixedTime(new Date(2026, 10, 10, 9));
  await page.goto(`${B}/calendar`);
  const month = page.getByRole('button', { name: /^Month$/ }).first();
  if (await month.count()) await month.click();
  await page.getByText('Committee').first().waitFor({ timeout: 8000 });
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Committee' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (JSON.stringify(cells.filter((c) => ['2', '16'].includes(c))) !== '["2","16"]' || cells.some((c) => ['9', '23', '30'].includes(c))) throw new Error(`shown on ${JSON.stringify(cells)}`);
});

await step('the event says “first and third Monday”, and renaming it keeps that', async () => {
  await page.getByText('Committee').first().click();
  const dlg = page.getByRole('dialog').first();
  let sel = dlg.getByRole('combobox', { name: 'Repeat', exact: true });
  if (!(await sel.count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); sel = page.getByRole('dialog').first().getByRole('combobox', { name: 'Repeat', exact: true }); }
  const text = await sel.evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first and third Monday/.test(text)) throw new Error(`the repeat reads “${text}”`);
  const d2 = page.getByRole('dialog').first();
  await d2.getByLabel('Title').fill('Committee meeting');
  await d2.getByRole('button', { name: 'Save' }).click();
  // A repeating event: asked which ones to change: all of them.
  const all = page.getByRole('radio', { name: 'All events' });
  await all.waitFor({ timeout: 5000 });
  await all.check();
  await all.locator('xpath=ancestor::form').getByRole('button').last().click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.id === id);
  if (ev?.title !== 'Committee meeting') throw new Error(`title: ${ev?.title}`);
  if (JSON.stringify(ev.rrule) !== JSON.stringify({ freq: 'monthly', nths: [1, 3], wd: 1 })) throw new Error(`the repeat became ${JSON.stringify(ev.rrule)}`);
});
await step('made in the web: a one-off set to repeat on the first and third Monday', async () => {
  const start = await page.evaluate(() => new Date(2026, 10, 2, 12).getTime());
  const one = (await api('POST', '/events', { title: 'Lunch and learn', start, end: start + 3600e3 })).body;
  await page.clock.setFixedTime(new Date(2026, 10, 10, 9));
  await page.goto(`${B}/calendar`);
  await page.getByText('Lunch and learn').first().click();
  let dlg = page.getByRole('dialog').first();
  if (!(await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).count())) { await dlg.getByRole('button', { name: /Edit/ }).first().click(); dlg = page.getByRole('dialog').first(); }
  await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('monthly-nths');
  const weeks = dlg.getByRole('group', { name: 'Which Mondays of the month' });
  if (!(await weeks.getByRole('checkbox', { name: 'First' }).isChecked())) throw new Error('the start’s own week isn’t ticked');
  await weeks.getByRole('checkbox', { name: 'Third' }).check();
  const shown = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first and third Monday/.test(shown)) throw new Error(`the repeat reads “${shown}”`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 90 * 864e5}`)).body.find((e) => e.id === one.id);
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', nths: [1, 3], wd: 1 })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
  const cells = (await page.locator('.month').first().locator(':scope > *', { hasText: 'Lunch and learn' }).allInnerTexts()).map((c) => c.split('\n')[0].trim());
  if (!cells.includes('16')) throw new Error(`shown on ${JSON.stringify(cells)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
