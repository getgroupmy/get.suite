import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const M = `${ROOT}/server/node_modules`;
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import(`${M}/docx/dist/index.mjs`);
const ExcelJS = (await import(`${M}/exceljs/lib/exceljs.nodejs.js`)).default;
const PptxGenJS = (await import(`${M}/pptxgenjs/dist/pptxgen.cjs.js`)).default;
const upload = (name, b64) => page.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);

await step('setup: upload a Word, an Excel and a PowerPoint file', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: 'Service agreement', heading: HeadingLevel.HEADING_1 }), new Paragraph({ children: [new TextRun('Payment within '), new TextRun({ text: '30 days', bold: true }), new TextRun('.')] })] }] }));
  await upload('Agreement.docx', docx.toString('base64'));
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Quote'); ws.getCell('A1').value = 'Bolts'; ws.getCell('B1').value = 120; ws.getCell('B2').value = { formula: 'B1*2' };
  await upload('Quote.xlsx', Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'));
  const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE'; p.addSlide().addText('Kick-off', { x: 1, y: 2, w: 11, h: 1.5, fontSize: 40, bold: true, align: 'center' });
  await upload('Kickoff.pptx', (await p.write({ outputType: 'nodebuffer' })).toString('base64'));
});

await step('Word: open as a document, then download it as Word again', async () => {
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for Agreement.docx').click();
  await page.getByRole('menuitem', { name: 'Open as document' }).click();
  await page.waitForURL(/\/docs\//);
  await page.getByRole('heading', { name: 'Service agreement' }).waitFor();
  await page.locator('.paper strong', { hasText: '30 days' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/office-doc.png` });
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Word (.docx)' }).click()]);
  if (dl.suggestedFilename() !== 'Agreement.docx') throw new Error(dl.suggestedFilename());
});

await step('Excel: open from the preview as a spreadsheet; formulas work', async () => {
  await page.goto(B + '/drive');
  await page.getByRole('cell', { name: 'Quote.xlsx', exact: true }).dblclick();
  await page.getByRole('dialog', { name: 'Quote.xlsx' }).getByRole('button', { name: 'Open as spreadsheet' }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('.grid td[data-k="B2"]', { hasText: '240' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  if (dl.suggestedFilename() !== 'Quote.xlsx') throw new Error(dl.suggestedFilename());
});

await step('PowerPoint: open as a presentation, download as PowerPoint', async () => {
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for Kickoff.pptx').click();
  await page.getByRole('menuitem', { name: 'Open as presentation' }).click();
  await page.waitForURL(/\/slides\//);
  await page.locator('.slide-stage').getByText('Kick-off').waitFor();
  await page.screenshot({ path: `${SP}/shots/office-slides.png` });
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PowerPoint (.pptx)' }).click()]);
  if (dl.suggestedFilename() !== 'Kickoff.pptx') throw new Error(dl.suggestedFilename());
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
