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
await step('a Rich Text file made by pandoc opens with its nested list, footnote and code block', async () => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('pandoc', ['--version']).status !== 0) { console.log('(no pandoc here: skipped)'); return; }
  const buf = spawnSync('pandoc', ['-f', 'gfm', '-t', 'rtf', '-s'], { input: '- Fruit\n  - Apples\n\nSee the note[^1].\n\n```\nnpm test\n```\n\n[^1]: Bought on Monday.\n' }).stdout;
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'From pandoc rtf.rtf', mimeType: 'application/rtf', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'From pandoc rtf'));
  await page.goto(`${B}/docs/${f.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.locator('ul ul li', { hasText: 'Apples' }).waitFor(); // (was "– Apples" in a paragraph)
  if ((await ed.locator('sup[data-footnote]').getAttribute('title')) !== 'Bought on Monday.') throw new Error('the footnote'); // (was left out)
  if ((await ed.locator('pre').textContent()) !== 'npm test') throw new Error('the code block'); // (was a paragraph of code)
});
await step('a web page made by pandoc opens with its checklist and footnote', async () => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('pandoc', ['--version']).status !== 0) { console.log('(no pandoc here: skipped)'); return; }
  const buf = spawnSync('pandoc', ['-f', 'gfm', '-t', 'html', '-s', '--metadata', 'title=Plan'], { input: '- [ ] Book the room\n- [x] Send the agenda\n\nSee the note[^1].\n\n[^1]: Bought on Monday.\n' }).stdout;
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'From pandoc web.html', mimeType: 'text/html', buffer: buf });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'From pandoc web'));
  await page.goto(`${B}/docs/${f.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.locator('ul[data-type="taskList"] li', { hasText: 'Send the agenda' }).waitFor(); // (was a bullet list, its boxes gone)
  if ((await ed.locator('ul[data-type="taskList"] li[data-checked="true"]').count()) !== 1) throw new Error('ticks');
  if ((await ed.locator('sup[data-footnote]').getAttribute('title')) !== 'Bought on Monday.') throw new Error('the footnote'); // (was a "1" linking to a list at the end)
});
await step('an Excel file made by openpyxl: it opens with its note and chart; text that looks like a number or formula stays text, and nothing is struck through', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io, openpyxl
from openpyxl.styles import Font
wb = openpyxl.Workbook(); ws = wb.active
ws['A1'] = 'Code'; ws['A1'].font = Font(b=True, strike=False)
ws['A2'] = '007'; ws['A2'].data_type = 's'
ws['A3'] = '=not a formula'; ws['A3'].data_type = 's'
ws['A4'] = 12.5
from openpyxl.comments import Comment
ws['A4'].comment = Comment('Checked by Zoë', 'Someone')
from openpyxl.chart import BarChart, Reference
ws['C1'] = 'Month'; ws['D1'] = 'Sales'; ws['C2'] = 'Jan'; ws['D2'] = 10; ws['C3'] = 'Feb'; ws['D3'] = 12
ch = BarChart(); ch.title = 'Sales by month'; ch.add_data(Reference(ws, min_col=4, min_row=1, max_row=3), titles_from_data=True); ch.set_categories(Reference(ws, min_col=3, min_row=2, max_row=3)); ws.add_chart(ch, 'F2')
buf = io.BytesIO(); wb.save(buf); sys.stdout.buffer.write(buf.getvalue())
`]);
  if (r.status !== 0) { console.log('(no openpyxl here: skipped)'); return; }
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'From openpyxl.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: r.stdout });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'From openpyxl'));
  await page.goto(`${B}/sheets/${f.id}`);
  const grid = page.locator('[role="grid"]').first();
  await grid.getByText('Code', { exact: true }).waitFor();
  await grid.getByText('007', { exact: true }).waitFor(); // (it was the number 7)
  await grid.getByText('=not a formula', { exact: true }).waitFor(); // (it was a formula, showing an error)
  const struck = await grid.getByText('Code', { exact: true }).evaluate((el) => getComputedStyle(el.closest('[role="gridcell"]') || el).textDecorationLine);
  if (/line-through/.test(struck)) throw new Error('struck through'); // (every cell was)
  const content = (await api(page, 'GET', `/files/${f.id}/content`)).body.content;
  const charts = Object.values((content.sheets || content)[0].charts || {});
  if (JSON.stringify(charts.map((c) => [c.type, c.range, c.title])) !== JSON.stringify([['column', 'C1:D3', 'Sales by month']])) throw new Error(`the chart: ${JSON.stringify(charts)}`); // (a file with a chart didn't open)
  if ((content.sheets || content)[0].notes?.A4 !== 'Checked by Zoë') throw new Error(`the note: ${JSON.stringify((content.sheets || content)[0].notes)}`); // (a file with a note didn't open at all)
});
await step('an Excel file with a picture over its cells (openpyxl): it shows, moves by dragging, and the .xlsx download has it where it was put, beside the chart; Delete takes it away', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io, openpyxl
from openpyxl.drawing.image import Image
from openpyxl.chart import BarChart, Reference
from PIL import Image as P
wb = openpyxl.Workbook(); ws = wb.active
ws['A1'] = 'Logo'; ws['A2'] = 1; ws['A3'] = 2
b = io.BytesIO(); P.new('RGB', (120, 60), (220, 30, 30)).save(b, 'PNG'); b.seek(0)
ws.add_image(Image(b), 'C3')
ch = BarChart(); ch.add_data(Reference(ws, min_col=1, min_row=2, max_row=3)); ws.add_chart(ch, 'H2')
buf = io.BytesIO(); wb.save(buf); sys.stdout.buffer.write(buf.getvalue())
`]);
  if (r.status !== 0) { console.log('(no openpyxl or Pillow here: skipped)'); return; }
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'With a logo.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: r.stdout });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'With a logo'));
  await page.goto(`${B}/sheets/${f.id}`);
  const pic = page.locator('.sheet-picture').first();
  await pic.waitFor();
  await until(async () => (await pic.locator('img').evaluate((i) => i.complete && i.naturalWidth)) === 120); // (the picture was dropped)
  const box = await pic.boundingBox();
  if (Math.round(box.width) !== 120 || Math.round(box.height) !== 60) throw new Error(`its size: ${box.width}x${box.height}`);
  const c3 = await page.locator('.grid td[data-k="C3"]').boundingBox();
  if (Math.abs(box.x - c3.x) > 2 || Math.abs(box.y - c3.y) > 2) throw new Error(`not over C3: ${JSON.stringify([box, c3])}`);
  // Drag it one column (100px) right and down a row.
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 40, { steps: 4 }); await page.mouse.move(box.x + 130, box.y + 54, { steps: 4 }); await page.mouse.up();
  const content = async () => { const c = (await api(page, 'GET', `/files/${f.id}/content`)).body.content; return (c.sheets || c)[0]; };
  await until(async () => { const p = Object.values((await content()).pictures || {})[0]; return p && p.x === 346 && p.y === 96; }, 10000);
  const xlsx = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=xlsx`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, f.id);
  const read = spawnSync('python3', ['-I', '-c', `
import sys, io, base64, json, openpyxl
ws = openpyxl.load_workbook(io.BytesIO(base64.b64decode(sys.stdin.read()))).active
print(json.dumps({ 'pics': [[i.anchor._from.col, i.anchor._from.row, i.anchor.ext.width // 9525, i.anchor.ext.height // 9525, i.width, i.height] for i in ws._images], 'charts': len(ws._charts) }))
`], { input: xlsx });
  const got = JSON.parse(String(read.stdout) || '{}');
  if (JSON.stringify(got) !== JSON.stringify({ pics: [[3, 3, 120, 60, 120, 60]], charts: 1 })) throw new Error(`the download: ${JSON.stringify(got)} ${read.stderr}`);
  await pic.focus();
  await page.keyboard.press('Delete');
  await page.locator('.sheet-picture').waitFor({ state: 'detached' });
  await until(async () => !Object.keys((await content()).pictures || {}).length, 10000);
});
await step('an OpenDocument spreadsheet LibreOffice made, with a picture tied to a cell: the picture shows over that cell, and the .ods download has it there', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ods-'));
  const made = spawnSync('python3', ['-I', '-c', `
import sys, io, openpyxl
from openpyxl.drawing.image import Image
from PIL import Image as P
wb = openpyxl.Workbook(); ws = wb.active; ws['A1'] = 'Stamp'
b = io.BytesIO(); P.new('RGB', (90, 45), (20, 160, 60)).save(b, 'PNG'); b.seek(0)
ws.add_image(Image(b), 'D6')
wb.save(sys.argv[1])
`, path.join(dir, 'Stamped.xlsx')]);
  if (made.status !== 0 || spawnSync('soffice', ['--headless', '--convert-to', 'ods', '--outdir', dir, path.join(dir, 'Stamped.xlsx')], { timeout: 120000 }).status !== 0) { console.log('(no openpyxl, Pillow or LibreOffice here: skipped)'); return; }
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'Stamped.ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', buffer: fs.readFileSync(path.join(dir, 'Stamped.ods')) });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Stamped'));
  await page.goto(`${B}/sheets/${f.id}`);
  const pic = page.locator('.sheet-picture').first();
  await pic.waitFor();
  await until(async () => (await pic.locator('img').evaluate((i) => i.complete && i.naturalWidth)) === 90); // (it was dropped)
  const [box, d6] = [await pic.boundingBox(), await page.locator('.grid td[data-k="D6"]').boundingBox()];
  if (Math.abs(box.x - d6.x) > 2 || Math.abs(box.y - d6.y) > 2 || Math.round(box.width) !== 90 || Math.round(box.height) !== 45) throw new Error(`not 90 × 45 over D6: ${JSON.stringify([box, d6])}`);
  const ods = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=ods`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, f.id);
  const { sheetFromOds } = await import(`${ROOT}/server/src/office/ods.js`);
  const back = Object.values((await sheetFromOds(Buffer.from(ods, 'base64'), { savePicture: async () => 'x' })).sheets[0].pictures || {});
  const content = (await api(page, 'GET', `/files/${f.id}/content`)).body.content;
  const mine = Object.values((content.sheets || content)[0].pictures || {})[0];
  if (back.length !== 1 || back[0].x !== mine.x || back[0].y !== mine.y || back[0].w !== 90) throw new Error(`the download: ${JSON.stringify([back, mine])}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
await step('Picture in the Sheets toolbar: a picture from the computer goes over the cursor\'s cell at its size (big ones made smaller), and a colleague sees it', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io
from PIL import Image as P
b = io.BytesIO(); P.new('RGB', (960, 480), (30, 120, 220)).save(b, 'PNG'); sys.stdout.buffer.write(b.getvalue())
`]);
  if (r.status !== 0) { console.log('(no Pillow here: skipped)'); return; }
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Team photo' })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  await cell('B4').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert picture' }).click();
  await (await chooser).setFiles({ name: 'Team day.png', mimeType: 'image/png', buffer: r.stdout });
  const pic = page.locator('.sheet-picture').first();
  await pic.waitFor();
  await until(async () => (await pic.locator('img').evaluate((i) => i.complete && i.naturalWidth)) === 960);
  const [box, b4] = [await pic.boundingBox(), await cell('B4').boundingBox()];
  if (Math.round(box.width) !== 480 || Math.round(box.height) !== 240) throw new Error(`its size: ${box.width}x${box.height}`); // 960 × 480, made 480 wide
  if (Math.abs(box.x - b4.x) > 2 || Math.abs(box.y - b4.y) > 2) throw new Error(`not over B4: ${JSON.stringify([box, b4])}`);
  if ((await pic.getAttribute('aria-label')) !== 'Picture: Team day') throw new Error(await pic.getAttribute('aria-label'));
  // Saved, and Liam (who can view) sees it.
  const saved = await until(async () => { const c = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content; return Object.values(c.sheets[0].pictures || {})[0]; }, 10000);
  const lid = (await api(page, 'POST', '/users', { local: 'liam', domain: 'acme.com', name: 'Liam Viewer', password: 'password123' })).body.id;
  const liam = await mk('liam');
  await signIn(liam, 'liam@acme.com');
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: lid, role: 'viewer' }] });
  await liam.goto(`${B}/sheets/${sheet.id}`);
  const theirs = liam.locator('.sheet-picture img');
  await until(async () => (await theirs.evaluate((i) => i.complete && i.naturalWidth).catch(() => 0)) === 960);
  if (await liam.getByRole('button', { name: /Options for picture/ }).count()) throw new Error('a viewer can change it');
  if (saved.alt !== 'Team day' || saved.w !== 480) throw new Error(JSON.stringify(saved));
  await liam.close();
});
await step('a picture pasted (Ctrl+V of a screenshot) goes over the cursor\'s cell; an image file dropped on the grid goes where it was let go; text pasted still fills cells', async () => {
  const { spawnSync } = await import('node:child_process');
  const mk = (w, h, kind) => spawnSync('python3', ['-I', '-c', `import sys, io\nfrom PIL import Image\nb = io.BytesIO(); Image.new('RGB', (${w}, ${h}), (90, 30, 160)).save(b, '${kind}'); sys.stdout.buffer.write(b.getvalue())`]).stdout;
  const png = mk(150, 100, 'PNG'), jpg = mk(64, 48, 'JPEG');
  if (!png?.length || !jpg?.length) { console.log('(no Pillow here: skipped)'); return; }
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Pasted pictures' })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  await cell('C5').click();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.querySelector('.grid-wrap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  const pics = page.locator('.sheet-picture');
  await until(async () => (await pics.count()) === 1 && (await pics.first().locator('img').evaluate((i) => i.complete && i.naturalWidth)) === 150);
  const [a, c5] = [await pics.first().boundingBox(), await cell('C5').boundingBox()];
  if (Math.abs(a.x - c5.x) > 2 || Math.abs(a.y - c5.y) > 2 || Math.round(a.width) !== 150 || Math.round(a.height) !== 100) throw new Error(`pasted: ${JSON.stringify([a, c5])}`);
  // Dropped over F12, a little into the cell.
  const f12 = await cell('F12').boundingBox();
  await page.evaluate(([b64, x, y]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'Stamp.jpg', { type: 'image/jpeg' }));
    const at = document.elementFromPoint(x, y);
    at.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    at.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [jpg.toString('base64'), f12.x + 10, f12.y + 6]);
  await until(async () => (await pics.count()) === 2);
  const dropped = page.locator('.sheet-picture[aria-label="Picture: Stamp"]');
  await until(async () => (await dropped.locator('img').evaluate((i) => i.complete && i.naturalWidth)) === 64);
  const d = await dropped.boundingBox();
  if (Math.abs(d.x - (f12.x + 10)) > 2 || Math.abs(d.y - (f12.y + 6)) > 2 || Math.round(d.width) !== 64) throw new Error(`dropped: ${JSON.stringify([d, f12])}`);
  // Text on the clipboard is still pasted into cells.
  await cell('A1').click();
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'one\ttwo'); document.querySelector('.grid-wrap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await until(async () => (await cell('B1').innerText()).trim() === 'two');
  const saved = await until(async () => { const c = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content; const p = Object.values(c.sheets[0].pictures || {}); return p.length === 2 ? p : null; }, 10000);
  if (saved.map((p) => p.alt).sort().join() !== 'Stamp,image') throw new Error(JSON.stringify(saved));
});
await step('Alt text… in a picture\'s menu: what a screen reader says, kept, and in the .xlsx download', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Pasted pictures');
  if (!f) throw new Error('no Pasted pictures spreadsheet (an earlier step failed)');
  await page.goto(`${B}/sheets/${f.id}`);
  const pic = page.locator('.sheet-picture[aria-label="Picture: image"]');
  await pic.waitFor();
  await pic.hover();
  await pic.getByRole('button', { name: 'Options for picture image' }).click();
  await page.getByRole('menuitem', { name: 'Alt text…' }).click();
  await page.getByLabel("Describe the picture for people who can't see it").fill('Team logo, purple');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.sheet-picture[aria-label="Picture: Team logo, purple"] img[alt="Team logo, purple"]').waitFor();
  await until(async () => Object.values((await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0].pictures || {}).some((p) => p.alt === 'Team logo, purple'), 10000);
  const xlsx = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=xlsx`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, f.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(Buffer.from(xlsx, 'base64'));
  const drawing = await zip.file(Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))).async('string');
  if (!/descr="Team logo, purple"/.test(drawing)) throw new Error(`the download: ${drawing.slice(0, 400)}`);
});
await step('pictures move with their cells: rows inserted above, a column before them widened', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Pasted pictures');
  if (!f) throw new Error('no Pasted pictures spreadsheet (an earlier step failed)');
  await page.goto(`${B}/sheets/${f.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  const logo = page.locator('.sheet-picture[aria-label="Picture: Team logo, purple"]'), stamp = page.locator('.sheet-picture[aria-label="Picture: Stamp"]');
  await logo.waitFor();
  const over = async (pic, key, dx, dy) => { const [a, c] = [await pic.boundingBox(), await cell(key).boundingBox()]; return a && c && Math.abs(a.x - c.x - dx) <= 2 && Math.abs(a.y - c.y - dy) <= 2; };
  // Two rows above row 3: the logo (C5) is over C7 now, the stamp (10 × 6 into F12) over F14.
  await cell('A3').click();
  await page.keyboard.down('Shift'); await cell('A4').click(); await page.keyboard.up('Shift');
  await cell('A3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 2 rows above/ }).click();
  await until(async () => (await over(logo, 'C7', 0, 0)) && (await over(stamp, 'F14', 10, 6)));
  // Column B 80 pixels wider: both move 80 to the right, still over their cells.
  const sep = page.getByRole('separator', { name: 'Resize column B' });
  const b = await sep.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2, { steps: 4 }); await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2, { steps: 4 }); await page.mouse.up();
  await until(async () => (await over(logo, 'C7', 0, 0)) && (await over(stamp, 'F14', 10, 6)));
  // Saved so: where Excel finds them too.
  const pics = await until(async () => { const c = (await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0]; const p = Object.values(c.pictures || {}); return c.colWidths?.B >= 170 && p.find((q) => q.alt === 'Stamp')?.y === 24 + 24 * 13 + 6 ? p : null; }, 10000);
  if (!pics) throw new Error('not saved');
});
await step('charts and slicers move with their cells too: two rows inserted above them', async () => {
  const content = { sheets: [{ name: 'Sales', cells: { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '10', A3: 'Feb', B3: '12' }, colWidths: {},
    charts: { c1: { type: 'column', range: 'A1:B3', title: 'Sales by month', x: 46 + 200, y: 24 + 48, w: 360, h: 240 } },
    slicers: { s1: { range: 'A1:B3', col: 'A', hidden: [], x: 46 + 400 + 8, y: 24 + 72 + 4 } } }] };
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Moving chart', content })).body;
  await page.goto(`${B}/sheets/${f.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  const chart = page.locator('.chart-card', { hasText: 'Sales by month' });
  await chart.waitFor();
  const over = async (loc, key, dx, dy) => { const [a, c] = [await loc.boundingBox(), await cell(key).boundingBox()]; return a && c && Math.abs(a.x - c.x - dx) <= 2 && Math.abs(a.y - c.y - dy) <= 2; };
  const slicer = page.locator('.chart-layer > .slicer').first();
  if (!(await over(chart, 'C3', 0, 0))) throw new Error('the chart not over C3 to begin with');
  await cell('A1').click();
  await page.keyboard.down('Shift'); await cell('A2').click(); await page.keyboard.up('Shift');
  await cell('A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 2 rows above/ }).click();
  await until(async () => (await over(chart, 'C5', 0, 0)) && (await over(slicer, 'E6', 8, 4))).catch(async (e) => { console.log('DBG', JSON.stringify({ chart: await chart.boundingBox(), c5: await cell('C5').boundingBox(), slicer: await slicer.boundingBox(), e6: await cell('E6').boundingBox(), saved: (await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0] })); throw e; });
  const saved = (await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0];
  if (saved.charts.c1.range !== 'A3:B5' || saved.charts.c1.y !== 24 + 24 * 4) throw new Error(JSON.stringify(saved.charts));
});
await step('the spreadsheet with a chart, published to the web: the chart is drawn over its cell, from its cells', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Moving chart');
  if (!f) throw new Error('no Moving chart spreadsheet (the step before failed)');
  const pub = (await api(page, 'PUT', `/publish/${f.id}`, { on: true })).body;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anon = await ctx.newPage();
  anon.on('pageerror', (e) => errors.push(`anonymous: ${e.message}`));
  await anon.goto(`${B}${pub.path}`);
  const chart = anon.locator('.pub-sheet td[data-k="C5"] .pub-chart[aria-label="Chart: Sales by month"]');
  await chart.waitFor();
  await chart.locator('svg').first().waitFor();
  const [a, td] = [await chart.boundingBox(), await anon.locator('.pub-sheet td[data-k="C5"]').boundingBox()];
  if (Math.abs(a.x - td.x - 1) > 2 || Math.abs(a.y - td.y - 1) > 2 || Math.round(a.width) !== 360) throw new Error(JSON.stringify([a, td]));
  // Its bars, from the cells: Jan and Feb.
  const text = await chart.innerText();
  if (!/Jan/.test(text) || !/Feb/.test(text)) throw new Error(`the chart's labels: ${text}`);
  await ctx.close();
});
await step('the spreadsheet with a chart, downloaded as PDF: the chart is drawn in it, its bars from the cells (read by pdfplumber)', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Moving chart');
  if (!f) throw new Error('no Moving chart spreadsheet (an earlier step failed)');
  const pdf = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=pdf`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, f.id);
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io, json, base64, pdfplumber
with pdfplumber.open(io.BytesIO(base64.b64decode(sys.stdin.read()))) as pdf:
    p = pdf.pages[0]
    blue = [r for r in p.rects if tuple(round(c, 2) for c in (r.get('non_stroking_color') or ())) == (0.1, 0.45, 0.91)]
    print(json.dumps({ 'text': p.extract_text(), 'bars': [round(r['height'], 2) for r in sorted(blue, key=lambda r: r['x0'])] }))
`], { input: pdf });
  if (r.status !== 0) { console.log('(no pdfplumber here: skipped)'); return; }
  const got = JSON.parse(String(r.stdout));
  if (!/Sales by month/.test(got.text)) throw new Error('no chart title in the PDF');
  if (got.bars.length !== 2 || Math.abs(got.bars[0] / got.bars[1] - 10 / 12) > 0.02) throw new Error(`the bars: ${JSON.stringify(got.bars)} (Jan 10, Feb 12)`);
});
await step('a document and a presentation with a chart, downloaded as PDF: the chart is drawn, its bars from its figures (pdfplumber)', async () => {
  const { spawnSync } = await import('node:child_process');
  const data = { categories: ['North', 'South', 'East'], series: [{ name: 'Units', values: [12, 30, 18] }] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Region report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'By region:' }] }, { type: 'sheetChart', attrs: { title: 'Units by region', chartType: 'column', data: JSON.stringify(data) } }] } })).body;
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Region deck', content: { slides: [{ id: 'a', items: [{ id: 'c', type: 'chart', title: 'Units by region', chartType: 'column', data, x: 10, y: 10, w: 80, h: 70 }] }] } })).body;
  for (const f of [doc, deck]) {
    const pdf = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=pdf`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, f.id);
    const r = spawnSync('python3', ['-I', '-c', `
import sys, io, json, base64, pdfplumber
with pdfplumber.open(io.BytesIO(base64.b64decode(sys.stdin.read()))) as pdf:
    p = pdf.pages[0]
    blue = [r for r in p.rects if tuple(round(c, 2) for c in (r.get('non_stroking_color') or ())) == (0.1, 0.45, 0.91)]
    print(json.dumps({ 'text': p.extract_text(), 'bars': [round(r['height'], 2) for r in sorted(blue, key=lambda r: r['x0'])] }))
`], { input: pdf });
    if (r.status !== 0) { console.log('(no pdfplumber here: skipped)'); return; }
    const got = JSON.parse(String(r.stdout));
    if (!/Units by region/.test(got.text) || !/Units/.test(got.text)) throw new Error(`${f.name}: ${got.text}`);
    if (got.bars.length !== 3 || Math.abs(got.bars[0] / got.bars[1] - 12 / 30) > 0.02 || Math.abs(got.bars[2] / got.bars[1] - 18 / 30) > 0.02) throw new Error(`${f.name}: the bars ${JSON.stringify(got.bars)}`);
  }
});
await step('the document with a chart, downloaded as a web page and opened in the browser: the chart is drawn (bars measured on screen), its figures under it', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'Region report');
  if (!f) throw new Error('no Region report (the step before failed)');
  const html = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export?format=html`)).text(), f.id);
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const view = await ctx.newPage();
  await view.setContent(html);
  const bars = await view.locator('svg rect[fill="#1a73e8"]').evaluateAll((rs) => rs.map((r) => r.getBoundingClientRect().height).filter((h) => h >= 12));
  if (bars.length !== 3 || Math.abs(bars[0] / bars[1] - 12 / 30) > 0.02 || Math.abs(bars[2] / bars[1] - 18 / 30) > 0.02) throw new Error(`the bars on screen: ${JSON.stringify(bars)}`);
  if (await view.getByRole('img', { name: 'Units by region' }).count() !== 1) throw new Error('the chart has no name for screen readers');
  await view.getByRole('cell', { name: 'South' }).waitFor();
  await ctx.close();
});
await step('rows hidden above pictures: each still shows over its own cell, and is kept where it was; shown again, as before', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Pasted pictures');
  if (!f) throw new Error('no Pasted pictures spreadsheet (an earlier step failed)');
  await page.goto(`${B}/sheets/${f.id}`);
  const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
  const logo = page.locator('.sheet-picture[aria-label="Picture: Team logo, purple"]'), stamp = page.locator('.sheet-picture[aria-label="Picture: Stamp"]');
  await logo.waitFor();
  const over = async (pic, key, dx, dy) => { const [a, c] = [await pic.boundingBox(), await cell(key).boundingBox()]; return a && c && Math.abs(a.x - c.x - dx) <= 2 && Math.abs(a.y - c.y - dy) <= 2; };
  const kept = async () => JSON.stringify(Object.values((await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0].pictures || {}).map((p) => [p.x, p.y]).sort());
  const before = await kept();
  await page.locator('.grid tbody th', { hasText: /^3$/ }).click();
  await page.locator('.grid tbody th', { hasText: /^4$/ }).click({ modifiers: ['Shift'] });
  await page.locator('.grid tbody th', { hasText: /^4$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide rows 3–4', exact: true }).click();
  await until(async () => (await cell('A3').count()) === 0);
  await until(async () => (await over(logo, 'C7', 0, 0)) && (await over(stamp, 'F14', 10, 6))); // (they stayed where they were on the page)
  // Moving one while rows are hidden keeps it against all rows: a column to the right, still over row 7.
  const box = await logo.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 20, { steps: 4 }); await page.mouse.move(box.x + 120, box.y + 20, { steps: 4 }); await page.mouse.up();
  await until(async () => over(logo, 'D7', 0, 0));
  await page.getByRole('button', { name: 'Show hidden rows 3–4' }).click();
  await cell('A3').waitFor();
  await until(async () => (await over(logo, 'D7', 0, 0)) && (await over(stamp, 'F14', 10, 6)));
  const after = JSON.parse(await kept()), was = JSON.parse(before);
  if (!after.some(([x, y]) => y === was.find(([, yy]) => yy === y)?.[1])) throw new Error(`kept: ${JSON.stringify([was, after])}`);
  // Put back (a column to the left) for the steps after.
  const b2 = await logo.boundingBox();
  await page.mouse.move(b2.x + 20, b2.y + 20); await page.mouse.down(); await page.mouse.move(b2.x - 30, b2.y + 20, { steps: 4 }); await page.mouse.move(b2.x - 80, b2.y + 20, { steps: 4 }); await page.mouse.up();
  await until(async () => over(logo, 'C7', 0, 0));
  await until(async () => (await kept()) === before, 10000);
});
await step('Duplicate (in a picture\'s menu, or Ctrl+D): a copy of it a little lower and to the right, of the same picture', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Pasted pictures');
  await page.goto(`${B}/sheets/${f.id}`);
  const stamps = page.locator('.sheet-picture[aria-label="Picture: Stamp"]');
  await stamps.first().waitFor();
  const saved = async () => Object.values((await api(page, 'GET', `/files/${f.id}/content`)).body.content.sheets[0].pictures || {}).filter((p) => p.alt === 'Stamp');
  const [orig] = await saved();
  await stamps.first().hover();
  await stamps.first().getByRole('button', { name: 'Options for picture Stamp' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await until(async () => (await stamps.count()) === 2);
  const [a, b] = [await stamps.nth(0).boundingBox(), await stamps.nth(1).boundingBox()];
  const [first, second] = [a, b].sort((p, q) => p.x - q.x);
  if (Math.round(second.x - first.x) !== 16 || Math.round(second.y - first.y) !== 16 || Math.round(second.width) !== Math.round(first.width)) throw new Error(JSON.stringify([a, b]));
  await until(async () => { const l = await saved(); return l.length === 2 && l.every((p) => p.file === orig.file); }, 10000);
  // Ctrl+D on a picture that has the focus.
  await stamps.nth(1).focus();
  await page.keyboard.press('Control+d');
  await until(async () => (await stamps.count()) === 3);
  await until(async () => (await saved()).length === 3, 10000);
  // Delete the copies (Delete on each), for the steps after.
  for (let i = 0; i < 2; i++) {
    const all = await saved();
    const boxes = await stamps.evaluateAll((l) => l.map((x) => x.getBoundingClientRect().x));
    await stamps.nth(boxes.indexOf(Math.max(...boxes))).focus();
    await page.keyboard.press('Delete');
    await until(async () => (await saved()).length === all.length - 1, 10000);
  }
  const [left] = await saved();
  if (left.x !== orig.x || left.y !== orig.y) throw new Error('the original was deleted, not the copy');
});
await step('Print or save as PDF: the pictures and the chart over the cells are on the printed page, in their cells', async () => {
  const printOf = async (name) => {
    const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === name);
    if (!f) throw new Error(`no ${name} spreadsheet (an earlier step failed)`);
    await page.goto(`${B}/sheets/${f.id}`);
    await page.locator('.grid td[data-k="A1"]').click();
    // (printing happens in a frame: keep its print window from opening in the test browser)
    await page.evaluate(() => { const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow'); Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() { const w = d.get.call(this); if (w) w.print = () => {}; return w; } }); });
    await page.evaluate(() => document.querySelectorAll('iframe.print-frame').forEach((x) => x.remove()));
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
    const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
    await d.getByLabel('This sheet').check();
    await d.getByRole('button', { name: 'Print' }).click();
    await page.locator('iframe.print-frame').waitFor({ state: 'attached' });
    return page.frameLocator('iframe.print-frame');
  };
  const pics = await printOf('Pasted pictures');
  const imgs = pics.locator('td.has-over .over img');
  await until(async () => (await imgs.count()) === 2 && (await imgs.evaluateAll((l) => l.every((i) => i.complete && i.naturalWidth > 0))));
  if (!(await pics.locator('td.has-over', { has: pics.locator('img[alt="Stamp"]') }).count())) throw new Error('the stamp is not in a cell');
  const chart = await printOf('Moving chart');
  const svg = chart.locator('td.has-over .over.chart svg');
  await svg.waitFor({ state: 'attached' });
  if ((await chart.locator('td.has-over .over.chart p').innerText()) !== 'Sales by month') throw new Error('the chart\'s title');
  if ((await svg.locator('rect').count()) < 2) throw new Error('the chart\'s bars');
});
await step('the spreadsheet with pictures, published to the web: someone without an account sees each picture in its cell', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Pasted pictures');
  if (!f) throw new Error('no Pasted pictures spreadsheet (an earlier step failed)');
  const pub = (await api(page, 'PUT', `/publish/${f.id}`, { on: true })).body;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anon = await ctx.newPage();
  anon.on('pageerror', (e) => errors.push(`anonymous: ${e.message}`));
  await anon.goto(`${B}${pub.path}`);
  const pics = anon.locator('.pub-sheet img.pub-picture');
  await until(async () => (await pics.count()) === 2);
  await until(async () => (await pics.evaluateAll((l) => l.map((i) => i.complete && i.naturalWidth))).join() === '150,64');
  // The pasted one over C7 (its corner at the cell's corner), the dropped one 10 × 6 pixels into F14.
  for (const [alt, key, dx, dy, w] of [['Team logo, purple', 'C7', 0, 0, 150], ['Stamp', 'F14', 10, 6, 64]]) { // (moved down two rows by the step before)
    const img = anon.locator(`.pub-sheet td[data-k="${key}"] img.pub-picture[alt="${alt}"]`);
    const [a, td] = [await img.boundingBox(), await anon.locator(`.pub-sheet td[data-k="${key}"]`).boundingBox()];
    if (!a || Math.abs(a.x - td.x - 1 - dx) > 2 || Math.abs(a.y - td.y - 1 - dy) > 2 || Math.round(a.width) !== w) throw new Error(`${alt}: ${JSON.stringify([a, td])}`);
  }
  await ctx.close();
});
await step('a colleague who can edit copies the sheet with Olivia\'s picture to a new spreadsheet of their own: the picture shows there', async () => {
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Team photo');
  if (!f) throw new Error('no Team photo spreadsheet (an earlier step failed)');
  const liam = await mk('liam-copy');
  await signIn(liam, 'liam@acme.com');
  const lid = (await api(liam, 'GET', '/auth/me')).body?.user?.id;
  if (!lid) throw new Error('no Liam');
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: lid, role: 'editor' }] });
  await liam.goto(`${B}/sheets/${f.id}`);
  await liam.locator('.sheet-picture img').waitFor();
  await liam.locator('button.tab-menu').first().click();
  await liam.getByRole('menuitem', { name: 'Copy to a new spreadsheet' }).click();
  const link = liam.getByRole('link', { name: 'Open it' });
  await link.waitFor();
  await liam.goto(new URL(await link.getAttribute('href'), B).href);
  const img = liam.locator('.sheet-picture img');
  await img.waitFor();
  await until(async () => (await img.evaluate((i) => i.complete && i.naturalWidth)) === 960, 10000); // (a broken picture: Olivia can't edit Liam's spreadsheet)
  await liam.close();
});
await step('the spreadsheet with a picture, downloaded as PDF: the picture is on its page (read by pypdf)', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'sheet' && x.name === 'Team photo');
  if (!f) throw new Error('no Team photo spreadsheet (the step before failed)');
  const pdf = await page.evaluate(async (id) => { const r = await fetch(`/api/files/${id}/export?format=pdf`); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return [r.headers.get('content-type'), btoa(s)]; }, f.id);
  if (!/pdf/.test(pdf[0])) throw new Error(pdf[0]);
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io, json, base64, pypdf
print(json.dumps([[n, list(i.image.size)] for n, pg in enumerate(pypdf.PdfReader(io.BytesIO(base64.b64decode(sys.stdin.read()))).pages) for i in pg.images]))
`], { input: pdf[1] });
  if (r.status !== 0) { console.log('(no pypdf here: skipped)'); return; }
  const got = JSON.parse(String(r.stdout));
  if (JSON.stringify(got) !== JSON.stringify([[0, [960, 480]]])) throw new Error(`the pictures in the PDF: ${JSON.stringify(got)}`); // (none: pictures weren't drawn)
});
await step('a Word file made by python-docx: an item in its "List Bullet 2" style opens a level down', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['-I', '-c', `
import sys, io
from docx import Document
d = Document()
d.add_paragraph('Fruit', style='List Bullet')
d.add_paragraph('Apples', style='List Bullet 2')
d.add_paragraph('Vegetables', style='List Bullet')
buf = io.BytesIO(); d.save(buf); sys.stdout.buffer.write(buf.getvalue())
`]);
  if (r.status !== 0) { console.log('(no python-docx here: skipped)'); return; }
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'From python-docx.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: r.stdout });
  const f = await until(async () => (await api(page, 'GET', '/files?view=mine')).body.find((x) => x.kind === 'doc' && x.name === 'From python-docx'));
  await page.goto(`${B}/docs/${f.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.locator('ul ul li', { hasText: 'Apples' }).waitFor(); // (it was the second of three at the same level)
  if ((await ed.locator(':scope > ul > li').count()) !== 2) throw new Error('two items at the top');
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
