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
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const fmts = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].formats || {};
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Qty', A2: 'Bolts', B2: '4', A3: 'Nuts', B3: '9', A4: 'This note is long enough that it has to wrap onto another line' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
await step('strikethrough from the toolbar and with Alt+Shift+5', async () => {
  await cell('A2').click();
  await page.getByRole('button', { name: 'Strikethrough' }).click();
  if (!(await style('A2', 'textDecorationLine')).includes('line-through')) throw new Error('no strike');
  await cell('A3').click();
  await page.keyboard.press('Alt+Shift+5');
  if (!(await style('A3', 'textDecorationLine')).includes('line-through')) throw new Error('no strike by key');
  await page.keyboard.press('Alt+Shift+5');
  if ((await style('A3', 'textDecorationLine')).includes('line-through')) throw new Error('not toggled off');
});
await step('wrap text makes the row taller', async () => {
  const before = (await cell('A4').boundingBox()).height;
  await cell('A4').click();
  await page.getByRole('button', { name: 'Wrap text' }).click();
  await until(async () => (await cell('A4').boundingBox()).height > before + 10);
  if ((await style('A4', 'whiteSpace')) !== 'pre-wrap') throw new Error('not wrapping');
});
await step('outer border on a range, then all borders, then none', async () => {
  await cell('A1').click();
  await cell('B3').click({ modifiers: ['Shift'] });
  await page.getByLabel('Borders').selectOption('outer');
  const w = async (k, side) => (await style(k, `border${side}Width`)) + '/' + (await style(k, `border${side}Style`));
  if ((await w('A1', 'Top')) !== '1px/solid' || (await w('A1', 'Left')) !== '1px/solid') throw new Error('A1 top/left ' + await w('A1', 'Top') + ' ' + await w('A1', 'Left') + ' ' + await cell('A1').getAttribute('style'));
  if ((await w('B3', 'Bottom')) !== '1px/solid' || (await w('B3', 'Right')) !== '1px/solid') throw new Error('B3 bottom/right');
  if ((await w('A2', 'Top')) !== '0px/none') throw new Error('inside has no top: ' + await w('A2', 'Top'));
  await page.screenshot({ path: process.argv[2] + '/shots/borders.png' });
  let f;
  await until(async () => (f = await fmts()).B3?.bd === 'br').catch(() => {});
  if (f.A1?.bd !== 'tl' || f.B3.bd !== 'br' || f.A2.bd !== 'l' || f.B2.bd !== 'r') throw new Error(JSON.stringify(f));
  await page.getByLabel('Borders').selectOption('all');
  await until(async () => (await w('A2', 'Top')) === '1px/solid');
  await page.getByLabel('Borders').selectOption('none');
  await until(async () => (await w('A1', 'Top')) === '0px/none');
  await until(async () => !(f = await fmts()).A1?.bd).catch(() => {});
  if (f.A1?.bd || f.B3?.bd) throw new Error('cleared ' + JSON.stringify(f));
  if (!f.A2?.s) throw new Error('strike kept');
});
await step('Clear formatting removes them too', async () => {
  await cell('A2').click();
  await page.getByRole('button', { name: 'Clear formatting' }).click();
  await until(async () => !(await style('A2', 'textDecorationLine')).includes('line-through'));
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
