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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Data', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Name', B1: 'City', A2: 'Ann', B2: 'Leeds', A3: 'Bob', B3: 'York', A4: 'ann', B4: 'leeds ', A5: 'Cat', B5: 'Hull', A6: 'Bob', B6: 'York',
    D1: 'Full name', D2: 'Kim Park', D3: 'Lee Chan', E3: 'old' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const now = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].cells;
await step('Remove duplicates from the right-click menu: two repeated rows go, the rest close up', async () => {
  await cell('A3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove duplicates…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Remove duplicates' });
  await dlg.getByText('A1:B6').waitFor();
  await dlg.getByLabel('The first row is headings').check(); // all text: not guessed
  await dlg.getByRole('button', { name: 'Remove duplicates' }).click();
  await page.getByText('Removed 2 duplicate rows; 3 left').waitFor();
  await until(async () => { const c = await now(); return [c.A2, c.A3, c.A4, c.A5, c.A1].join() === 'Ann,Bob,Cat,,Name'; });
  if ((await cell('B4').innerText()) !== 'Hull') throw new Error('B4');
});
await step('Undo brings them back', async () => {
  await page.keyboard.press('Control+z');
  await until(async () => (await now()).A6 === 'Bob');
});
await step('Split text to columns: first and last names, over what was there', async () => {
  await cell('D2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Split text to columns…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Split text to columns' });
  await dlg.getByText('D1:D3').waitFor();
  await dlg.getByLabel('Split at').selectOption({ label: 'Space' });
  await dlg.getByRole('button', { name: 'Split' }).click();
  await page.getByText('Split into 2 columns (1 cell written over)').waitFor();
  await until(async () => { const c = await now(); return [c.D2, c.E2, c.D3, c.E3, c.D1, c.E1].join('|') === 'Kim|Park|Lee|Chan|Full|name'; });
  await page.screenshot({ path: SP + '/shots/split.png' });
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
