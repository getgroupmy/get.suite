// TODAY() and NOW() in Sheets, in a browser in Kuala Lumpur at 7:30 on Saturday morning (Friday 23:30 in UTC): the date
// and time there, as in Excel and Google Sheets (before, Friday 20 November and 23:30, the date and time in UTC).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Kuala_Lumpur' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const text = async (k) => (await cell(k).innerText()).trim();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const typeIn = async (k, s) => { await cell(k).click(); await page.keyboard.type(s); await page.keyboard.press('Enter'); };
let sheet;
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Shifts', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Start' } }] } })).body;
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 10, 20, 23, 30))); // Saturday 21 November, 7:30 in Kuala Lumpur
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
});
await step('=TODAY() is Saturday 21 November there, =NOW() 7:30', async () => {
  await typeIn('B1', '=TODAY()');
  await typeIn('B2', '=NOW()');
  await typeIn('B3', '=TEXT(TODAY(),"dddd d mmmm")');
  await typeIn('B4', '=HOUR(NOW())');
  await until(async () => (await text('B3')) !== '');
  const got = { B1: await text('B1'), B2: await text('B2'), B3: await text('B3'), B4: await text('B4') };
  if (!/21/.test(got.B1) || /20/.test(got.B1.replace('2026', ''))) throw new Error(`TODAY() shows ${got.B1}`);
  if (!/07:30|7:30/.test(got.B2)) throw new Error(`NOW() shows ${got.B2}`);
  if (got.B3 !== 'Saturday 21 November') throw new Error(`TEXT(TODAY()) shows ${got.B3}`);
  if (got.B4 !== '7') throw new Error(`HOUR(NOW()) shows ${got.B4}`);
  console.log('   ', JSON.stringify(got));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
