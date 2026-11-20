// Sheets → ⋮ → Import CSV as new sheet, with a file as Excel saves it in much of Europe: semicolons, a byte-order mark,
// a name with a comma in quotes, decimal commas, a line break in a quoted field. Before, the browser split on commas
// only: "Smith" and " John" in two cells, the rest of each row in one, and the mark inside A1.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'x' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').waitFor();
});
await step('a semicolon file comes in as its columns', async () => {
  const csv = '﻿Name;Amount;Note\r\n"Smith, John";1,5;"two\nlines"\r\nJones;2,25;"say ""hi"""\r\n';
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /More|⋮/ }).first().click();
  await page.getByRole('menuitem', { name: 'Import CSV as new sheet' }).click();
  await (await chooser).setFiles({ name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('tab', { name: /prices/ }).first().waitFor({ timeout: 8000 }).catch(() => {});
  await until(async () => (await text('A2')) === 'Smith, John', 8000).catch(() => {});
  const got = {};
  for (const k of ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3']) got[k] = await text(k);
  const want = { A1: 'Name', B1: 'Amount', C1: 'Note', A2: 'Smith, John', B2: '1,5', C2: 'two lines', A3: 'Jones', B3: '2,25', C3: 'say "hi"' }; // (the grid shows a line break as a space)
  for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`${k}: ${JSON.stringify(got[k])}, not ${JSON.stringify(v)} (all: ${JSON.stringify(got)})`);
  // and kept: the line break in the cell, and the new sheet named after the file
  let saved;
  await until(async () => { saved = (await api(page, 'GET', `/files/${sheet.id}/content`)).body?.content?.sheets?.find((x) => x.name === 'prices'); return !!saved; });
  if (saved.cells.C2 !== 'two\nlines' || saved.cells.A1 !== 'Name') throw new Error(`saved ${JSON.stringify(saved.cells)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
