import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: '2026-11-07', A2: '=DATE(2026, 12, 25)', A3: '=EDATE(A1, 2)', A4: 'soon' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('Date format shows dates in a chosen style; the value stays the same', async () => {
  await cell('A1').click();
  await cell('A4').click({ modifiers: ['Shift'] });
  await page.getByLabel('Number format').selectOption('date');
  await until(async () => (await cell('A1').innerText()) === '7 Nov 2026');
  if ((await cell('A2').innerText()) !== '25 Dec 2026') throw new Error('formula date ' + await cell('A2').innerText());
  if ((await cell('A3').innerText()) !== '7 Jan 2027') throw new Error('EDATE ' + await cell('A3').innerText());
  if ((await cell('A4').innerText()) !== 'soon') throw new Error('text left alone');
  await page.getByLabel('Date style').selectOption('long');
  await until(async () => (await cell('A1').innerText()) === 'Saturday, 7 November 2026');
  if (await page.getByLabel('Fewer decimals').count()) throw new Error('decimals for dates');
  await cell('A1').click();
  if ((await page.getByLabel('Cell contents').inputValue()) !== '2026-11-07') throw new Error('value changed');
  await page.getByLabel('Date style').selectOption('short');
  await until(async () => (await cell('A1').innerText()) === '07/11/2026');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
