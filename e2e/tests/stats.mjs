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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Ad spend', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', B1: '3', B2: '5', B3: '7', B4: '9', B5: '12' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('a trend line: SLOPE, INTERCEPT and FORECAST, with help while typing', async () => {
  await cell('D1').click();
  await page.keyboard.type('=forec');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('FORECAST') || !names.includes('FORECAST.LINEAR')) throw new Error(names.join(','));
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if ((await help.locator('b').innerText()) !== 'x') throw new Error('first argument');
  if (!(await help.innerText()).includes('straight line')) throw new Error(await help.innerText());
  await page.screenshot({ path: `${SP}/shots/forecast-help.png` });
  await page.keyboard.type('10, B1:B5, A1:A5)');
  await page.keyboard.press('Enter');
  for (const [k, f] of [['D2', '=SLOPE(B1:B5, A1:A5)'], ['D3', '=INTERCEPT(B1:B5, A1:A5)'], ['D4', '=ROUND(CORREL(B1:B5, A1:A5), 3)'],
    ['D5', '=MEDIAN(A1:A5)=QUARTILE(A1:A5, 2)'], ['D6', '=PERCENTILE(B1:B5, 0.5)'], ['D7', '=MROUND(B5, 5)'], ['D8', '=ROWS(A1:B5)*COLUMNS(A1:B5)'], ['D9', '=MODE(A1:A5)']]) {
    await cell(k).click(); await page.keyboard.type(f); await page.keyboard.press('Enter');
  }
  const want = { D1: '22.6', D2: '2.2', D3: '0.6', D4: '0.996', D5: 'TRUE', D6: '7', D7: '10', D8: '10', D9: '#N/A' };
  await until(async () => { for (const [k, v] of Object.entries(want)) if ((await cell(k).innerText()).trim() !== v) return false; return true; })
    .catch(async () => { throw new Error(JSON.stringify(await Promise.all(Object.keys(want).map(async (k) => [k, await cell(k).innerText()])))); });
  await page.screenshot({ path: `${SP}/shots/stats.png` });
});
await step('they come out in the Excel download with Excel\'s names', async () => {
  await cell('E1').click(); await page.keyboard.type('=FORECAST.LINEAR(6, B1:B5, A1:A5)'); await page.keyboard.press('Enter');
  await until(async () => (await cell('E1').innerText()).trim() === '13.8');
  await page.waitForTimeout(2000);
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] }; }, sheet.id);
  if (r.status !== 200) throw new Error('status ' + r.status);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(r.bytes))).file('xl/worksheets/sheet1.xml').async('string');
  if (!xml.includes('_xlfn.FORECAST.LINEAR(6,B1:B5,A1:A5)') && !xml.includes('_xlfn.FORECAST.LINEAR(6, B1:B5, A1:A5)')) throw new Error(xml.match(/<f>[^<]*<\/f>/g)?.join(' '));
  if (!/<f>SLOPE\(B1:B5, ?A1:A5\)<\/f>/.test(xml)) throw new Error('SLOPE');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
