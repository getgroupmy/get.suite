import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Hide', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Name', B1: 'Secret', C1: 'Total', A2: 'Ann', B2: '7', C2: '=B2*2', A3: 'Bob', A4: 'Cat', A5: 'Dan' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const hideNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].hide || null;
const visible = (k) => cell(k).isVisible();
const colHead = (l) => page.locator('.grid thead th').nth(l.charCodeAt(0) - 64);
const at = () => page.locator('.formula-bar .cell-name').inputValue();
await step('hide a column from its heading menu; formulas still use it', async () => {
  await colHead('B').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide column B', exact: true }).click();
  await until(async () => JSON.stringify(await hideNow()) === '{"cols":[1]}');
  if (await visible('B2')) throw new Error('B2 still shown');
  if ((await cell('C2').innerText()) !== '14') throw new Error('formula ' + await cell('C2').innerText());
  await page.screenshot({ path: SP + '/shots/hidecol.png' });
});
await step('arrows step over the hidden column', async () => {
  await cell('A2').click();
  await page.keyboard.press('ArrowRight');
  if ((await at()) !== 'C2') throw new Error('at ' + await at());
  await page.keyboard.press('ArrowLeft');
  if ((await at()) !== 'A2') throw new Error('back at ' + await at());
});
await step('hide rows 3–4 from the row menu', async () => {
  await page.locator('.grid tbody th', { hasText: /^3$/ }).click();
  await page.locator('.grid tbody th', { hasText: /^4$/ }).click({ modifiers: ['Shift'] });
  await page.locator('.grid tbody th', { hasText: /^4$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide rows 3–4', exact: true }).click();
  await until(async () => JSON.stringify(await hideNow()) === '{"rows":[2,3],"cols":[1]}');
  if (await cell('A3').count()) throw new Error('row 3 still drawn');
  await cell('A5').waitFor();
});
await step('the buttons next to them show them again', async () => {
  await page.getByRole('button', { name: 'Show hidden rows 3–4' }).click();
  await until(async () => JSON.stringify(await hideNow()) === '{"cols":[1]}');
  await cell('A3').waitFor();
  await page.getByRole('button', { name: 'Show hidden column B' }).click();
  await until(async () => (await hideNow()) === null);
  if (!(await visible('B2'))) throw new Error('B2 hidden');
});
await step('Undo hides the column again; "Unhide columns" over a selection shows it', async () => {
  await cell('C3').click();
  await page.keyboard.press('Control+z');
  await until(async () => JSON.stringify(await hideNow()) === '{"cols":[1]}');
  await colHead('A').click();
  await colHead('C').click({ modifiers: ['Shift'] });
  await colHead('C').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unhide columns', exact: true }).click();
  await until(async () => (await hideNow()) === null);
});
await step('inserting a column before moves what is hidden', async () => {
  await cell('A5').click();
  await colHead('C').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide column C', exact: true }).click();
  await until(async () => JSON.stringify(await hideNow()) === '{"cols":[2]}');
  await colHead('A').click();
  await colHead('A').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Insert 1 column left/ }).click();
  await until(async () => JSON.stringify(await hideNow()) === '{"cols":[3]}');
  if ((await cell('D2').innerText().catch(() => '')) && await visible('D2')) throw new Error('D2 should be hidden');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
