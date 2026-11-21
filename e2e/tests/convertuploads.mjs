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
});
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Tab } = await import(`${ROOT}/server/node_modules/docx/dist/index.mjs`);
const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: 'Supplier contract', heading: HeadingLevel.HEADING_1 }), new Paragraph('Payment within 30 days.'),
  new Paragraph({ children: [new TextRun({ children: ['Ref:', new Tab(), 'A-7  (two spaces)'] })] })] }] })); // (a tab and two spaces, kept)
const pick = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
await step('without the setting, a .docx uploads as a file', async () => {
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(pick('Old contract.docx'));
  await page.getByText('Old contract.docx').first().waitFor();
});
await step('Settings: Convert uploads; a .docx uploaded in Drive becomes a document, the file goes to the trash', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel(/Convert uploads/).check();
  await page.getByText('Office files you upload will become documents').waitFor();
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(pick('Supplier contract.docx'));
  await page.getByText(/1 file converted to a document/).waitFor();
  await page.screenshot({ path: `${SP}/shots/convert-uploads.png` });
  const list = (await api(page, 'GET', '/files?view=mine')).body.map((f) => `${f.kind}:${f.name}`);
  if (!list.includes('doc:Supplier contract') || list.includes('file:Supplier contract.docx')) throw new Error(list.join(', '));
  if (!(await api(page, 'GET', '/files?view=trash')).body.some((f) => f.name === 'Supplier contract.docx')) throw new Error('not in the trash');
  await page.getByText('Supplier contract', { exact: true }).first().dblclick();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror h1', { hasText: 'Supplier contract' }).waitFor();
  await page.locator('.ProseMirror', { hasText: 'Payment within 30 days.' }).waitFor();
  const kept = await until(async () => (await api(page, 'GET', `/files?view=mine`)).body.find((f) => f.kind === 'doc' && f.name === 'Supplier contract'));
  const content = JSON.stringify((await api(page, 'GET', `/files/${kept.id}/content`)).body);
  if (!content.includes('Ref:\\tA-7  (two spaces)')) throw new Error(`the tab and two spaces: ${content.match(/Ref:[^"]*/)?.[0]}`);
});
await step('a Word file with a checklist inside a bulleted list comes in with the checklist still in the list, ticks kept', async () => {
  const { wordFromDoc } = await import(`${ROOT}/server/src/office/word.js`);
  const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const buf = await wordFromDoc({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [P('Launch'),
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P('Book the room')] }, { type: 'taskItem', attrs: { checked: false }, content: [P('Send invites')] }] }] }] }] });
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Plan.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'Plan'));
  await page.goto(`${B}/docs/${f.id}`);
  await page.locator('.ProseMirror ul li ul[data-type="taskList"] li[data-checked="true"]', { hasText: 'Book the room' }).waitFor();
  await page.locator('.ProseMirror ul li ul[data-type="taskList"] li[data-checked="false"]', { hasText: 'Send invites' }).waitFor();
});
await step('an Excel file with a number too big to be a date in a date-formatted cell opens (it didn\'t), and 0.000 stays 0.000', async () => {
  const { excelFromSheet } = await import(`${ROOT}/server/src/office/excel.js`);
  const buf = await excelFromSheet({ sheets: [{ name: 'Data', cells: { A1: '123456789012', A2: '1234.5' }, formats: { A1: { num: 'date' }, A2: { num: 'custom', code: '0.000' } } }] });
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Readings.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Readings'));
  await page.goto(`${B}/sheets/${f.id}`);
  await page.locator('.grid td[data-k="A2"]', { hasText: '1234.500' }).waitFor(); // (not 1,234.500)
  const sheet = (await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0];
  if (sheet.cells.A1 !== '123456789012') throw new Error(JSON.stringify(sheet.cells));
});
await step('an OpenDocument file ending with a table, as LibreOffice saves it (an empty paragraph after), comes in ending with the table', async () => {
  const { odtFromDoc } = await import(`${ROOT}/server/src/office/odt.js`);
  const cellP = (text) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const buf = await odtFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Prices' }] }, { type: 'table', content: [{ type: 'tableRow', content: [cellP('Tea'), cellP('3')] }] }, { type: 'paragraph' }] });
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Prices.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'Prices'));
  const blocks = (await api(page, 'GET', `/files/${f.id}/content`)).body.content.content.map((n) => n.type);
  if (blocks.join() !== 'paragraph,table') throw new Error(blocks.join());
});
await step('a Word file with a space each side of where bold starts, and a suggested deletion, opens with both spaces', async () => {
  const { wordFromDoc } = await import(`${ROOT}/server/src/office/word.js`);
  const del = { type: 'suggestDelete', attrs: { id: 's1', by: 'u1', name: 'Kim Park', at: Date.UTC(2026, 0, 4, 9, 30) } };
  const buf = await wordFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two ' }, { type: 'text', text: ' spaces', marks: [{ type: 'bold' }] }, { type: 'text', text: ' and ' }, { type: 'text', text: 'old', marks: [del] }, { type: 'text', text: ' words' }] }] }, 'Spaced');
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Spaced.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'Spaced'));
  await page.goto(`${B}/docs/${f.id}`);
  const editor = page.locator('.ProseMirror').first();
  await editor.getByText('spaces').waitFor();
  const text = await editor.evaluate((el) => el.textContent);
  if (text !== 'two  spaces and old words') throw new Error(JSON.stringify(text)); // (it was "two spaces": one space lost where bold starts)
  await editor.locator('del', { hasText: 'old' }).first().waitFor();
});
await step('Word and OpenDocument files made by pandoc (from Markdown) open with their quotes, code, lists and headings', async () => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('pandoc', ['--version']).status !== 0) { console.log('(no pandoc here: skipped)'); return; }
  const md = '## Plan\n\n> Quoted words\n\nRun `npm test` first.\n\n- Fruit\n  1. Apples\n  2. Pears\n\n```\nnpm install\nnpm test\n```\n\n- [ ] Open item\n- [x] Done item\n\n* Plain bullet\n';
  for (const [ext, mime] of [['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['odt', 'application/vnd.oasis.opendocument.text']]) {
    const buf = spawnSync('pandoc', ['-f', 'gfm', '-t', ext], { input: md }).stdout;
    await page.goto(`${B}/drive`);
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: `From pandoc ${ext}.${ext}`, mimeType: mime, buffer: buf });
    const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === `From pandoc ${ext}`));
    await page.goto(`${B}/docs/${f.id}`);
    const ed = page.locator('.ProseMirror').first();
    await ed.locator('h2', { hasText: 'Plan' }).waitFor();
    if (await ed.locator('h2 em').count()) throw new Error(`${ext}: the heading came in italic`);
    if ((await ed.locator('> p').first().textContent()) === '') throw new Error(`${ext}: an empty paragraph first`);
    await ed.locator('blockquote', { hasText: 'Quoted words' }).waitFor();
    await ed.locator('p code', { hasText: 'npm test' }).waitFor();
    await ed.locator('ul ol li', { hasText: 'Apples' }).waitFor();
    // a checklist, and the bullet list after it apart from it (they came in as one list, the box nested in a bullet)
    const lists = await ed.locator(':scope > ul').evaluateAll((l) => l.map((u) => `${u.getAttribute('data-type') || 'ul'}:${u.querySelectorAll(':scope > li').length}`));
    if (JSON.stringify(lists.slice(-2)) !== JSON.stringify(['taskList:2', 'ul:1'])) throw new Error(`${ext}: lists ${JSON.stringify(lists)}`);
    const pres = await ed.locator('pre').evaluateAll((l) => l.map((p) => p.textContent));
    if (JSON.stringify(pres) !== JSON.stringify(['npm install\nnpm test'])) throw new Error(`${ext}: code block ${JSON.stringify(pres)}`); // (a block a line from .odt; paragraphs of code from .docx)
  }
});
await step('a CSV uploaded becomes a spreadsheet whose amounts and dates are numbers and dates, shown as written', async () => {
  await page.goto(`${B}/drive`);
  const csv = 'Item,Price,Share,Due\nDesk,"$1,250.00",40%,05/12/2026\nLamp,"1,234",12.5%,20 Dec 2026\n';
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Orders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Orders'));
  await page.goto(`${B}/sheets/${f.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  await cell('B2').waitFor();
  const shown = async () => Promise.all(['B2', 'C2', 'D2', 'B3', 'C3', 'D3'].map(async (k) => (await cell(k).innerText()).trim()));
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(['$1,250.00', '40%', '05/12/2026', '1,234', '12.5%', '20 Dec 2026']));
  await cell('E2').click();
  await page.keyboard.type('=B2+B3&"|"&(D3-D2)');
  await page.keyboard.press('Enter');
  await until(async () => (await cell('E2').innerText()).trim() === '2484|15');
});
await step('a spreadsheet file whose formulas have small-letter functions and sheet names comes in tidied', async () => {
  const { odsFromSheet } = await import(`${ROOT}/server/src/office/ods.js`);
  const buf = await odsFromSheet({ sheets: [{ name: 'Main', cells: { A1: '2', B1: '=sum(Other!A1:A2)*2', B2: '=max(other!A1:A2)' } }, { name: 'Other', cells: { A1: '1', A2: '3' } }] });
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Mixed case.ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Mixed case'));
  const content = await until(async () => { const r = (await api(page, 'GET', `/files/${f.id}/content`)).body; const c = r?.content ?? r; return c?.sheets ? c : typeof c === 'string' ? JSON.parse(c) : null; });
  const cells = content.sheets.find((x) => x.name === 'Main').cells;
  if (cells.B1 !== '=SUM(Other!A1:A2)*2' || cells.B2 !== '=MAX(Other!A1:A2)') throw new Error(JSON.stringify(cells));
  await page.goto(`${B}/sheets/${f.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  await until(async () => (await cell('B1').innerText()).trim() === '8' && (await cell('B2').innerText()).trim() === '3');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
