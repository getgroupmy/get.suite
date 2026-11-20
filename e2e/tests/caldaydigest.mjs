// All-day repeats on the server's side, made in a browser east of its clock (Kuala Lumpur, the server on UTC): the
// morning summary lists today's all-day weekly event on its own weekday (before, a day late: worked out on the
// server's clock, a Monday there was a Tuesday).
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
await step('setup: an all-day event every week on today\'s weekday, from a week ago, and one on tomorrow\'s', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  // (the server's real today: the summary is for now, in Kuala Lumpur)
  const [tz, start, end, wd] = await page.evaluate(() => { const n = new Date(); const s = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7); return [Intl.DateTimeFormat().resolvedOptions().timeZone, s.getTime(), new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6).getTime() - 1, n.getDay()]; });
  for (const [title, days] of [['Gym day', [wd]], ['Pool day', [(wd + 1) % 7]]]) {
    const made = await api('POST', '/events', { title, start, end, all_day: 1, tz, rrule: { freq: 'weekly', byday: days } });
    if (made.status !== 201) throw new Error(`${made.status} ${JSON.stringify(made.body)}`);
  }
});
await step('the morning summary (in Kuala Lumpur) lists the Gym day as all day today, not the Pool day', async () => {
  // (its zone, as turning it on sets: this browser's; with no email here, it stays off)
  await api('PUT', '/users/me/digest', { hour: null, tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) });
  const d = (await api('GET', '/users/me/digest')).body;
  if (d.tz !== 'Asia/Kuala_Lumpur') throw new Error(`the summary's zone is ${d.tz}`);
  // (what "Send me one now" shows; that button is there when the server has email)
  const text = (await api('POST', '/users/me/digest/send', { preview: true })).body?.text || '';
  if (!/All day\s+Gym day/.test(text)) throw new Error(`the summary says: ${text.split('\n').slice(0, 6).join(' / ')}`);
  if (/Pool day/.test(text)) throw new Error('tomorrow\'s Pool day is in today\'s summary');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
