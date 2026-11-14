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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', A2: '10', A3: '20', A4: '30', B1: '0.5' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').waitFor();
});
const box = () => page.getByLabel('Name box');
const sheetNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0];
await step('select A2:A4 and name it from the right-click menu', async () => {
  await cell('A2').click();
  await cell('A4').click({ modifiers: ['Shift'] });
  if (await box().inputValue() !== 'A2:A4') throw new Error('name box ' + await box().inputValue());
  await cell('A3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Name this range…' }).click();
  const d = page.getByRole('dialog', { name: 'Named ranges' });
  if (await d.getByLabel('Cells').inputValue() !== 'A2:A4') throw new Error('prefilled');
  await d.getByLabel('Name', { exact: true }).fill('A5');
  await d.getByRole('button', { name: 'Add' }).click();
  await d.getByText(/looks like a cell/).waitFor();
  await d.getByLabel('Name', { exact: true }).fill('Sales');
  await d.getByRole('button', { name: 'Add' }).click();
  await d.getByRole('list', { name: 'Named ranges' }).getByText('Sales').waitFor();
  // A second one, typed in.
  await d.getByLabel('Name', { exact: true }).fill('Tax');
  await d.getByLabel('Cells').fill('b1');
  await d.getByRole('button', { name: 'Add' }).click();
  await d.getByRole('list', { name: 'Named ranges' }).getByText('B1', { exact: true }).waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  await until(async () => JSON.stringify((await sheetNow()).names) === JSON.stringify({ Sales: 'A2:A4', Tax: 'B1' }));
  if (await box().inputValue() !== 'Sales') throw new Error('box shows the name: ' + await box().inputValue());
});
await step('use the names in a formula', async () => {
  await cell('C1').dblclick();
  await page.keyboard.type('=SUM(Sales)*tax');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('C1').innerText()).trim() === '30');
  await cell('C2').dblclick();
  await page.keyboard.type('=Nope+1');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('C2').innerText()).trim() === '#NAME?');
});
await step('the name box goes to a name or a cell', async () => {
  await box().click();
  await box().fill('tax');
  await box().press('Enter');
  await until(async () => (await box().inputValue()) === 'Tax');
  await box().click(); await box().fill('D7'); await box().press('Enter');
  await until(async () => (await box().inputValue()) === 'D7');
  await box().click(); await box().fill('nothing'); await box().press('Enter');
  await page.getByText('There\'s no cell or named range called “nothing”').waitFor();
  await box().press('Escape');
});
await step('inserting a row moves the named range; the formula still works', async () => {
  await cell('A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Insert 1 row above' }).click();
  await until(async () => JSON.stringify((await sheetNow()).names) === JSON.stringify({ Sales: 'A3:A5', Tax: 'B2' }));
  await until(async () => (await cell('C2').innerText()).trim() === '30');
});
await step('rename and remove from ⋮ → Named ranges; Excel keeps them', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Named ranges' }).click();
  const d = page.getByRole('dialog', { name: 'Named ranges' });
  await d.getByRole('button', { name: 'Go to Sales' }).waitFor();
  await d.getByRole('button', { name: 'Remove Tax' }).click();
  await d.getByRole('button', { name: 'Change Sales' }).click();
  await d.getByLabel('Name', { exact: true }).fill('Revenue');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.getByRole('button', { name: 'Go to Revenue' }).click();
  await until(async () => (await box().inputValue()) === 'Revenue');
  await until(async () => JSON.stringify((await sheetNow()).names) === JSON.stringify({ Revenue: 'A3:A5' }));
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return [res.status, (await res.arrayBuffer()).byteLength]; }, sheet.id);
  if (r[0] !== 200 || r[1] < 1000) throw new Error('export ' + r);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
