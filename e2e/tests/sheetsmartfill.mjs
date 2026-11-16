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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'People', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Name', B1: 'Email', C1: 'Short',
    A2: 'Kim Park', B2: 'kim.park@acme.com', A3: 'Lee Chan', B3: 'lee.chan@acme.com', A4: 'Ana Maria Lopez', B4: 'ana.lopez@acme.com', A5: 'Bo Diaz', B5: 'bo.diaz@acme.com', C5: 'B. Diaz' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const now = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].cells;

await step('type one example, then Smart fill: it shows the pattern and what it fills in first', async () => {
  await cell('C2').dblclick();
  await page.keyboard.type('K. Park');
  await page.keyboard.press('Enter');
  await cell('C3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Smart fill…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Smart fill' });
  await dlg.getByText('the first letter of the first word of A + “. ” + the last word of A').waitFor();
  const t = dlg.getByRole('table', { name: 'What Smart fill puts in' });
  await t.getByRole('row', { name: /Lee Chan L\. Chan/ }).waitFor();
  await t.getByRole('row', { name: /Ana Maria Lopez A\. Lopez/ }).waitFor();
  await dlg.getByText(/From your 2 examples in column C/).waitFor();
  if (await t.getByText('Bo Diaz').count()) throw new Error('a filled cell is not written over');
  await axe(page, 'smart fill');
  await page.screenshot({ path: SP + '/shots/smartfill.png' });
  await dlg.getByRole('button', { name: 'Fill 2 cells' }).click();
  await page.getByText('Filled 2 cells in column C').waitFor();
  await saved();
  await until(async () => { const c = await now(); return [c.C2, c.C3, c.C4, c.C5].join('|') === 'K. Park|L. Chan|A. Lopez|B. Diaz'; });
});
await step('Undo takes the fill back', async () => {
  await page.keyboard.press('Control+z');
  await until(async () => { const c = await now(); return !c.C3 && !c.C4 && c.C2 === 'K. Park'; });
});
await step('nothing typed yet, no data beside, or examples that disagree: it says what to do', async () => {
  await cell('C4').dblclick();
  await page.keyboard.type('zzz');
  await page.keyboard.press('Enter');
  await cell('C3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Smart fill…' }).click();
  await page.getByText(/No pattern found that gives your examples|don't follow one pattern/).waitFor();
});
await step('an empty column beside the table, nothing typed in it yet', async () => {
  await cell('D3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Smart fill…' }).click();
  await page.getByText('Type what you want in a cell or two of this column first, then use Smart fill').waitFor();
});
await step('far from any data', async () => {
  await cell('H12').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Smart fill…' }).click();
  await page.getByText('Smart fill needs a column of data beside this one to learn from').waitFor();
});
const typeIn = async (k, text) => { await cell(k).dblclick(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
await step('offered by itself after a second example: Fill fills the rest of the column', async () => {
  await typeIn('E2', 'PARK');
  const bar = page.getByRole('region', { name: 'Smart fill suggestion' });
  if (await bar.count()) throw new Error('offered after one example');
  await typeIn('E3', 'CHAN');
  await bar.getByText(/fill 2 more cells in column E like your examples \(LOPEZ, DIAZ\)/).waitFor();
  await axe(page, 'smart fill offer');
  await page.screenshot({ path: SP + '/shots/smartfill-offer.png' });
  await bar.getByRole('button', { name: 'Fill' }).click();
  await page.getByText('Filled 2 cells in column E').waitFor();
  if (await bar.count()) throw new Error('bar stayed');
  await saved();
  await until(async () => { const c = await now(); return [c.E4, c.E5].join('|') === 'LOPEZ|DIAZ'; });
});
await step('No thanks: not offered again for that column; the same text twice is never offered', async () => {
  await typeIn('F2', 'kim');
  await typeIn('F3', 'lee');
  const bar = page.getByRole('region', { name: 'Smart fill suggestion' });
  await bar.waitFor();
  await bar.getByRole('button', { name: 'No thanks' }).click();
  await typeIn('F4', 'ana');
  await page.waitForTimeout(400);
  if (await bar.count()) throw new Error('offered again after No thanks');
  await typeIn('G2', 'Yes');
  await typeIn('G3', 'Yes');
  await page.waitForTimeout(400);
  if (await bar.count()) throw new Error('offered for the same text twice');
});
await step('dates: two examples in another form, and the rest are offered in it', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Dates', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Due', A2: '2026-11-15', A3: '2026-03-05', A4: '2026-12-25', A5: '2027-01-01' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').waitFor();
  await typeIn('B2', '15 Nov 2026');
  await typeIn('B3', '5 Mar 2026');
  const bar = page.getByRole('region', { name: 'Smart fill suggestion' });
  await bar.getByText(/fill 2 more cells in column B like your examples \(25 Dec 2026, 1 Jan 2027\)/).waitFor();
  await bar.getByRole('button', { name: 'Preview…' }).click();
  await page.getByRole('dialog', { name: 'Smart fill' }).getByText('the day of the date in A + “ ” + the month name, short of the date in A + “ ” + the year of the date in A').waitFor();
  await page.getByRole('dialog', { name: 'Smart fill' }).getByRole('button', { name: 'Fill 2 cells' }).click();
  await until(async () => { const c = await now(); return [c.B4, c.B5].join('|') === '25 Dec 2026|1 Jan 2027'; });
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
