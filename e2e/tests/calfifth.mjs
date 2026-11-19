// Monthly on the fifth Monday: shows in the months that have one (and not the others), and the event says so.
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
await step('setup: an event on the fifth Monday of each month, from 30 November 2026', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const start = await page.evaluate(() => new Date(2026, 10, 30, 10).getTime());
  const r = await api('POST', '/events', { title: 'Fifth Monday social', start, end: start + 3600e3, rrule: { freq: 'monthly', nth: 5, wd: 1 } });
  if (r.status >= 300) throw new Error(`event: ${r.status} ${JSON.stringify(r.body)}`);
});

await step('March 2027 has it on the 29th; April (four Mondays) doesn’t', async () => {
  await page.clock.setFixedTime(new Date(2027, 2, 15, 9));
  await page.goto(`${B}/calendar`);
  const month = page.getByRole('button', { name: /^Month$/ }).first();
  if (await month.count()) await month.click();
  await page.getByText('Fifth Monday social').first().waitFor({ timeout: 8000 });
  const grid = page.locator('.month').first();
  const n = await grid.getByText('Fifth Monday social').count();
  const cells = await grid.locator(':scope > *', { hasText: 'Fifth Monday social' }).allInnerTexts();
  if (JSON.stringify(cells.map((c) => c.split('\n')[0].trim())) !== '["29"]') throw new Error(`March shows it on ${JSON.stringify(cells)}`);
  if (n !== 1) throw new Error(`${n} shown in the March grid`);
  await page.getByRole('button', { name: /Next/ }).first().click();
  await page.waitForTimeout(800);
  const april = await page.locator('.month').first().locator(':scope > *', { hasText: 'Fifth Monday social' }).allInnerTexts();
  // (April's grid starts with 29 March, which has it; April's own Mondays are the 5th, 12th, 19th and 26th)
  if (april.some((c) => /^(5|12|19|26)\b/.test(c.trim()))) throw new Error('shown on a Monday in April, which has no fifth Monday');
});

await step('opening it: the repeat says “on the fifth Monday”', async () => {
  await page.clock.setFixedTime(new Date(2027, 2, 15, 9));
  await page.goto(`${B}/calendar`);
  await page.getByText('Fifth Monday social').first().click();
  const dlg = page.getByRole('dialog').first();
  const sel = dlg.getByRole('combobox', { name: 'Repeat', exact: true });
  if (!(await sel.count())) await dlg.getByRole('button', { name: /Edit/ }).first().click();
  const text = await sel.evaluate((el) => el.options[el.selectedIndex].text);
  if (!/fifth Monday/i.test(text)) throw new Error(`the repeat reads “${text}”`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
