import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, name: "test.acme.com" });
const req = (await import('module')).createRequire(`${ROOT}/server/package.json`);
const { Document, Packer, Paragraph, HeadingLevel } = req('docx');
const ExcelJS = req('exceljs');
const PptxGenJS = req('pptxgenjs');
const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: 'Tender response', heading: HeadingLevel.HEADING_1 }), new Paragraph('Delivery within six weeks.')] }] }));
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Costs'); ws.getCell('A1').value = 'Steel'; ws.getCell('B1').value = 1200; ws.getCell('B2').value = { formula: 'B1*2' };
const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
const ppt = new PptxGenJS(); ppt.layout = 'LAYOUT_WIDE';
const sl = ppt.addSlide(); sl.addText('Quarterly results', { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
sl.addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', x: 1, y: 3, w: 2, h: 2 });
const pptx = await ppt.write({ outputType: 'nodebuffer' });
const dlg = () => page.getByRole('dialog');
await step('Word, Excel and PowerPoint attachments open read-only in the viewer', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Tender pack', text: 'All three attached.',
    attachments: [{ filename: 'Tender.docx', content: docx }, { filename: 'Costs.xlsx', content: xlsx }, { filename: 'Results.pptx', content: pptx }, { filename: 'Old.doc', content: 'binary' }] });
  await refreshUntil(page, inboxRow('Tender pack'));
  await inboxRow('Tender pack').click();
  await page.getByRole('link', { name: /Tender\.docx/ }).click();
  await dlg().getByRole('heading', { name: 'Tender response' }).waitFor();
  await dlg().getByText('Delivery within six weeks.').waitFor();
  if (await dlg().locator('[contenteditable="true"]').count()) throw new Error('should be read-only');
  await dlg().getByText('1 of 3').waitFor();
  await page.keyboard.press('ArrowRight');
  await dlg().locator('td[data-k="A1"]', { hasText: 'Steel' }).waitFor();
  await dlg().locator('td[data-k="B2"]', { hasText: '2400' }).waitFor(); // formulas worked out
  await page.keyboard.press('ArrowRight');
  await dlg().getByText('Quarterly results').waitFor();
  const img = dlg().locator('.office-preview img').first();
  await until(() => img.evaluate((i) => i.complete && i.naturalWidth === 2));
  await page.keyboard.press('Escape');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Old\.doc/ }).click()]);
  if (dl.suggestedFilename() !== 'Old.doc') throw new Error('old Word files download');
});
await step('Drive shows Word files in its preview, and Open as still makes a copy', async () => {
  const id = await page.evaluate(async (b64) => {
    const r = await fetch('/api/files/upload?name=Proposal.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
    return (await r.json()).id;
  }, docx.toString('base64'));
  await page.goto(`${B}/drive`);
  await page.getByText('Proposal.docx', { exact: true }).first().dblclick();
  await dlg().getByRole('heading', { name: 'Tender response' }).waitFor();
  const before = (await api(page, 'GET', '/files')).body.length;
  if (before < 1 || !id) throw new Error('upload');
  await dlg().getByRole('button', { name: 'Open as document' }).click();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror', { hasText: 'Delivery within six weeks.' }).waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
