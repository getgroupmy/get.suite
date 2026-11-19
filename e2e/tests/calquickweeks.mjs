// Quick add in Calendar reads weeks of the month ("Committee every first and third Monday 6pm") and a short
// day name before a time ("Lunch fri 1pm").
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
await step('setup', async () => {
  await page.clock.setFixedTime(new Date(2026, 10, 19, 9)); // Thursday 19 November 2026
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
const quick = async (line) => {
  await page.goto(`${B}/calendar`);
  await page.getByLabel('Quick add an event').fill(line);
  await page.getByLabel('Quick add an event').press('Enter');
  const dlg = page.getByRole('dialog').first();
  await dlg.getByLabel('Title').waitFor();
  return dlg;
};
const saved = async (title) => {
  const t0 = await page.evaluate(() => new Date(2026, 10, 1).getTime());
  for (let k = 0; k < 20; k++) {
    const ev = (await api('GET', `/events?from=${t0}&to=${t0 + 120 * 864e5}`)).body.find((e) => e.title === title);
    if (ev) return ev;
    await page.waitForTimeout(250);
  }
  return null;
};

await step('“Committee every first and third Monday 6pm”: from 7 December, on the first and third Monday', async () => {
  const dlg = await quick('Committee every first and third Monday 6pm');
  if (await dlg.getByLabel('Title').inputValue() !== 'Committee') throw new Error(`title “${await dlg.getByLabel('Title').inputValue()}”`);
  const text = await dlg.getByRole('combobox', { name: 'Repeat', exact: true }).evaluate((el) => el.options[el.selectedIndex].text);
  if (!/first and third Monday/.test(text)) throw new Error(`the repeat reads “${text}”`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  const ev = await saved('Committee');
  if (JSON.stringify(ev?.rrule) !== JSON.stringify({ freq: 'monthly', nths: [1, 3], wd: 1 })) throw new Error(`saved as ${JSON.stringify(ev?.rrule)}`);
  const s = await page.evaluate((t) => { const d = new Date(t); return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}`; }, ev.start);
  if (s !== '12-7 18') throw new Error(`starts ${s}`);
});

await step('“Lunch fri 1pm”: Friday at 1pm, titled “Lunch”', async () => {
  const dlg = await quick('Lunch fri 1pm');
  if (await dlg.getByLabel('Title').inputValue() !== 'Lunch') throw new Error(`title “${await dlg.getByLabel('Title').inputValue()}”`);
  await dlg.getByRole('button', { name: 'Save' }).click();
  const ev = await saved('Lunch');
  const s = ev && await page.evaluate((t) => { const d = new Date(t); return `${d.getDay()} ${d.getDate()} ${d.getHours()}`; }, ev.start);
  if (s !== '5 20 13') throw new Error(`starts ${s}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
