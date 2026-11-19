// Formulas as Excel and Google Sheets files write them: array constants ({1,2,3}, spilling into the cells beside),
// trigonometry, ISNA/ISERR, LOOKUP, REPLACE and more (they used to show #NAME? or #ERROR!); and an Excel file
// using them opens with the right results.
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
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheetId;
const cell = (k) => page.locator(`[data-k="${k}"]`);
const typeIn = async (k, text) => { await cell(k).click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
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
  const cells = { A1: 'Name', B1: 'Email', C1: 'Score', A2: 'Ana', B2: 'ana@acme.com', C2: '72', A3: 'Bo', B3: 'bo@north.org', C3: '91', A4: 'Cy', B4: 'cy@acme.com', C4: '58' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Class', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('C3').getByText('91').waitFor();
});
await step('typed: an array constant spills, and sums', async () => {
  await typeIn('E1', '={10,20,30}');
  await until(async () => (await cell('E1').innerText()) === '10' && (await cell('F1').innerText()) === '20' && (await cell('G1').innerText()) === '30');
  await typeIn('E2', '=SUM({1,2;3,4})');
  await until(async () => (await cell('E2').innerText()) === '10');
});
await step('typed: trigonometry, ISNA, LOOKUP and REPLACE work out (no #NAME?)', async () => {
  await typeIn('E3', '=ROUND(DEGREES(ATAN2(1,1)),2)');
  await typeIn('E4', '=IF(ISNA(MATCH("Zed",A2:A4,0)),"not there","there")');
  await typeIn('E5', '=LOOKUP(80,{0,60,90},{"C","B","A"})');
  await typeIn('E6', '=REPLACE(B2,1,3,"anna")');
  await until(async () => (await cell('E3').innerText()) === '45' && (await cell('E4').innerText()) === 'not there' && (await cell('E5').innerText()) === 'B' && (await cell('E6').innerText()) === 'anna@acme.com');
  const shown = await page.locator('.grid, [role="grid"]').first().innerText();
  if (/#NAME\?|#ERROR!/.test(shown)) throw new Error('an error shows');
});
await step('typed: an inverse matrix spills; distributions, bases and depreciation work out', async () => {
  await typeIn('H5', '=MINVERSE({4,-1;2,0})');
  await typeIn('H8', '=ROUND(F.INV.RT(0.01,6,4),2)');
  await typeIn('H9', '=HEX2BIN("F",8)');
  await typeIn('H10', '=VDB(2400,300,10,0,1)');
  await until(async () => (await cell('H5').innerText()) === '0' && (await cell('I5').innerText()) === '0.5' && (await cell('H6').innerText()) === '-1' && (await cell('I6').innerText()) === '2'
    && (await cell('H8').innerText()) === '15.21' && (await cell('H9').innerText()) === '00001111' && (await cell('H10').innerText()) === '480');
});
await step('typed: AGGREGATE totals a column with an error in it', async () => {
  await typeIn('J1', '5');
  await typeIn('J2', '=1/0');
  await typeIn('J3', '7');
  await typeIn('J4', '=AGGREGATE(9,6,J1:J3)');
  await typeIn('J5', '=SUM(J1:J3)');
  await until(async () => (await cell('J4').innerText()) === '12' && (await cell('J5').innerText()) === '#DIV/0!');
});
await step('a filter: SUBTOTAL(109) totals only the rows still shown; SUM all of them', async () => {
  const cells2 = { A1: 'Team', B1: 'Hours', A2: 'Red', B2: '10', A3: 'Blue', B3: '20', A4: 'Red', B4: '30', A5: 'Blue', B5: '40', D1: '=SUBTOTAL(109,B2:B5)', D2: '=SUM(B2:B5)' };
  const id = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Hours', content: { sheets: [{ name: 'Sheet1', cells: cells2 }] } })).body.id;
  await page.goto(`${B}/sheets/${id}`);
  await until(async () => (await cell('D1').innerText()) === '100');
  await cell('A1').click();
  await page.getByRole('button', { name: 'Create a filter' }).click();
  await cell('A1').getByRole('button', { name: 'Filter A' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter column A' });
  await menu.getByLabel('Blue').uncheck();
  await menu.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await cell('D1').innerText()) === '40' && (await cell('D2').innerText()) === '100');
  // Downloaded as CSV, the total is the same as on screen.
  const csv = await page.evaluate(async (f) => (await fetch(`/api/files/${f}/export?format=csv`)).text(), id);
  if (!/^Team,Hours,,40\r?$/m.test(csv)) throw new Error(`the CSV has ${JSON.stringify(csv.split(/\r?\n/)[0])}`);
});
await step('a report with subtotals: the grand SUBTOTAL counts each row once', async () => {
  const cells3 = { A1: 'North', B1: '10', A2: 'North', B2: '20', A3: 'North total', B3: '=SUBTOTAL(9,B1:B2)', A4: 'South', B4: '5', A5: 'South total', B5: '=SUBTOTAL(9,B4)', A6: 'Grand total', B6: '=SUBTOTAL(9,B1:B5)', B7: '=SUM(B1:B5)' };
  const id = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Report', content: { sheets: [{ name: 'Sheet1', cells: cells3 }] } })).body.id;
  await page.goto(`${B}/sheets/${id}`);
  await until(async () => (await cell('B3').innerText()) === '30' && (await cell('B6').innerText()) === '35' && (await cell('B7').innerText()) === '70'); // SUM counts the subtotals too: 10+20+30+5+5
});
await step('Download as Excel writes the newer functions as Excel needs them (_xlfn.), so Excel works them out too', async () => {
  const id = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'For Excel', content: { sheets: [{ name: 'Sheet1', cells: { A1: '5', A2: '=1/0', A3: '=AGGREGATE(9,6,A1:A2)', A4: '=XOR(TRUE,FALSE)' } }] } })).body.id;
  const res = await page.request.get(`${B}/api/files/${id}/export`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(await res.body())).file('xl/worksheets/sheet1.xml').async('string');
  if (!xml.includes('<f>_xlfn.AGGREGATE(9,6,A1:A2)</f>') || !xml.includes('<f>_xlfn.XOR(TRUE,FALSE)</f>')) throw new Error(xml.slice(0, 600));
});
await step('Download as OpenDocument (.ods) names functions as LibreOffice needs them, and a CHAR(1) cell doesn’t spoil the file', async () => {
  const id = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'For LibreOffice', content: { sheets: [{ name: 'Sheet1', cells: { A1: '5', A2: '7', A3: '=STDEV.S(A1:A2)', A4: '=IFS(A1>3,"big",TRUE,"small")', A5: '=CHAR(1)&"x"' } }] } })).body.id;
  const res = await page.request.get(`${B}/api/files/${id}/export?format=ods`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(await res.body())).file('content.xml').async('string');
  if (!xml.includes('of:=COM.MICROSOFT.STDEV.S([.A1:.A2])') || !xml.includes('of:=COM.MICROSOFT.IFS(')) throw new Error(xml.slice(xml.indexOf('<table:table '), xml.indexOf('<table:table ') + 800));
  if (/[\u0000-\u0008]/.test(xml)) throw new Error('a control character in content.xml');
});
await step('a presentation with a control character in a text box downloads as a whole PowerPoint file', async () => {
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pasted deck', content: { slides: [{ id: 's1', items: [{ id: 'b1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Pasted \u0001text' }] }] } })).body.id;
  const res = await page.request.get(`${B}/api/files/${id}/export`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(await res.body())).file('ppt/slides/slide1.xml').async('string');
  if (/[\u0000-\u0008]/.test(xml) || !xml.includes('Pasted text')) throw new Error(xml.slice(0, 400));
});
await step('a PowerPoint file with its speaker notes in a plain text box (as LibreOffice writes them) opens with the notes', async () => {
  const { powerPointFromDeck } = await import(`${ROOT}/server/src/office/powerpoint.js`);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const z = await JSZip.loadAsync(await powerPointFromDeck({ slides: [{ id: 's1', items: [{ id: 'b1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Kick-off' }], notes: 'Thank everyone for coming' }] }, { title: 'K' }));
  const name = Object.keys(z.files).find((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n));
  z.file(name, (await z.file(name).async('string')).replace(/<p:ph type="body"[^>]*\/>/, ''));
  const up = await page.request.post(`${B}/api/files/upload?name=${encodeURIComponent('Kick-off.pptx')}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, data: await z.generateAsync({ type: 'nodebuffer' }) });
  const made = await api(page, 'POST', `/files/${(await up.json()).id}/open-as`);
  await page.goto(`${B}/slides/${made.body.id}`);
  await until(async () => (await page.getByLabel('Speaker notes').inputValue().catch(() => '')) === 'Thank everyone for coming', 15000);
  await page.goto(`${B}/sheets/${sheetId}`); // back to the sheet, for the steps after
  await cell('A1').waitFor();
});
await step('an .odt shaped as LibreOffice saves one (Word’s Quote and Code styles, an empty page layout first) opens with its quote, code and landscape page', async () => {
  const { odtFromDoc } = await import(`${ROOT}/server/src/office/odt.js`);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const z = await JSZip.loadAsync(await odtFromDoc({ type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted words' }] }] }, { type: 'codeBlock', content: [{ type: 'text', text: 'let x = 1;' }] }] }, 'Q', { page: { size: 'a4', orientation: 'landscape', margin: 'normal', header: '', footer: '', numbers: false } }));
  z.file('content.xml', (await z.file('content.xml').async('string')).replaceAll('text:style-name="Quotations"', 'text:style-name="Quote"').replaceAll('text:style-name="Preformatted_20_Text"', 'text:style-name="Code"'));
  let styles = (await z.file('styles.xml').async('string')).replace('style:name="Quotations"', 'style:name="Quote"').replace('style:name="Preformatted_20_Text" style:display-name="Preformatted Text"', 'style:name="Code" style:display-name="Code"');
  styles = styles.replace('<office:automatic-styles>', '<office:automatic-styles><style:page-layout style:name="pmEmpty"><style:page-layout-properties style:layout-grid-standard-mode="true"/></style:page-layout>');
  z.file('styles.xml', styles);
  const up = await page.request.post(`${B}/api/files/upload?name=${encodeURIComponent('From LibreOffice.odt')}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, data: await z.generateAsync({ type: 'nodebuffer' }) });
  const made = await api(page, 'POST', `/files/${(await up.json()).id}/open-as`);
  await page.goto(`${B}/docs/${made.body.id}`);
  await page.locator('.ProseMirror blockquote').getByText('Quoted words').waitFor();
  await page.locator('.ProseMirror pre').getByText('let x = 1;').waitFor();
  const f = (await api(page, 'GET', `/files/${made.body.id}`)).body;
  const setup = typeof f.page_setup === 'string' ? JSON.parse(f.page_setup) : f.page_setup;
  if (setup?.orientation !== 'landscape') throw new Error(`page setup: ${JSON.stringify(setup)}`);
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('A1').waitFor();
});
await step('suggestions know them, with help', async () => {
  await cell('E7').click();
  await page.keyboard.type('=atan');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('ATAN2')) throw new Error(names.join(','));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});
await step('an Excel file using them opens with the right results', async () => {
  const { excelFromSheet } = await import(`${ROOT}/server/src/office/excel.js`);
  const buf = await excelFromSheet({ sheets: [{ name: 'Sheet1', cells: { A1: 'x', A2: '=ROUND(SIN(PI()/2),0)', A3: '=ISERR(1/0)', A4: '=SUM({2,3,4})', A5: '=LOOKUP(2,{1,2,3},{"a","b","c"})' } }] });
  const up = await page.request.post(`${B}/api/files/upload?name=${encodeURIComponent('From Excel.xlsx')}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, data: buf });
  const f = await up.json();
  const made = await api(page, 'POST', `/files/${f.id}/open-as`);
  await page.goto(`${B}/sheets/${made.body.id}`);
  await until(async () => (await cell('A2').innerText()) === '1' && (await cell('A3').innerText()) === 'TRUE' && (await cell('A4').innerText()) === '9' && (await cell('A5').innerText()) === 'b', 15000);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
