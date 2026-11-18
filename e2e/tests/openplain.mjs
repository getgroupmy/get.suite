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
const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
const fs = await import('node:fs');
const upload = (name, body) => page.evaluate(async ([n, b]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: b })).json(), [name, body]);
const openFromDrive = async (name, what) => {
  await page.goto(B + '/drive');
  await page.getByLabel(`Actions for ${name}`).click();
  await page.getByRole('menuitem', { name: `Open as ${what}` }).click();
};
await step('a text file opens as a document, a paragraph a line', async () => {
  await upload('notes.txt', 'Shopping\n\nMilk\nBread');
  await openFromDrive('notes.txt', 'document');
  await page.waitForURL(/\/docs\//);
  await page.locator('.paper p', { hasText: 'Bread' }).waitFor();
  const paras = await page.locator('.ProseMirror > p').allInnerTexts();
  if (paras.map((t) => t.trim()).join('|') !== 'Shopping||Milk|Bread') throw new Error(paras.join('|'));
});
await step('a CSV file opens as a spreadsheet', async () => {
  await upload('people.csv', 'Name,Note\nAna,"says ""hi"", twice"\nBo,42\n');
  await openFromDrive('people.csv', 'spreadsheet');
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="B2"]').getByText('says "hi", twice').waitFor();
  await page.locator('[data-k="B3"]').getByText('42').waitFor();
});
await step('a web page downloaded from here opens as a document again: formatting, picture, equation, footnote', async () => {
  const content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Report' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Key', marks: [{ type: 'bold' }] }, { type: 'text', text: ' half is ' }, { type: 'math', attrs: { latex: '\\frac{1}{2}' } }, { type: 'footnote', attrs: { note: 'Roughly.' } }] }] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content })).body;
  const html = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export?format=html`)).text(), doc.id);
  await upload('Report page.html', html);
  await openFromDrive('Report page.html', 'document');
  await page.waitForURL(/\/docs\//);
  await page.getByRole('heading', { name: 'Report' }).waitFor();
  await page.locator('.paper strong', { hasText: 'Key' }).waitFor();
  await page.locator('.doc-math .katex').first().waitFor(); // drawn as an equation
  const id = page.url().split('/').pop();
  const json = JSON.stringify((await api(page, 'GET', `/files/${id}/content`)).body.content);
  if (!json.includes('"type":"footnote"') || !json.includes('Roughly.') || !json.includes('\\\\frac{1}{2}')) throw new Error(json.slice(0, 500));
});
await step('Download as Rich Text (.rtf), and the .rtf opens as a document again', async () => {
  const content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Memo' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Café ', marks: [{ type: 'italic' }] }, { type: 'text', text: 'opens', marks: [{ type: 'bold' }] }, { type: 'text', text: ' at 9.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Coffee' }] }] }] }] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Memo', content })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').getByText('opens').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Rich Text (.rtf)' }).click()]);
  if (dl.suggestedFilename() !== 'Memo.rtf') throw new Error(dl.suggestedFilename());
  const rtf = fs.readFileSync(await dl.path(), 'latin1');
  if (!rtf.startsWith('{\\rtf1') || !rtf.includes('Caf\\u233?')) throw new Error(rtf.slice(0, 300));
  await upload('Memo copy.rtf', rtf);
  await openFromDrive('Memo copy.rtf', 'document');
  await page.waitForURL(/\/docs\//);
  await page.getByRole('heading', { name: 'Memo' }).waitFor();
  await page.locator('.paper strong', { hasText: 'opens' }).waitFor();
  await page.locator('.paper em', { hasText: 'Café' }).waitFor();
  await page.locator('.paper ul li', { hasText: 'Coffee' }).waitFor();
});
await step('Download as PDF (.pdf): made on the server, on the page setup\'s paper, with the words in it', async () => {
  const content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly memo' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Sales grew in every region.' }] }] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Quarterly memo', content })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').getByText('Sales grew').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PDF (.pdf)' }).click()]);
  if (dl.suggestedFilename() !== 'Quarterly memo.pdf') throw new Error(dl.suggestedFilename());
  const buf = fs.readFileSync(await dl.path());
  const { PDFDocument } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
  const pdf = await PDFDocument.load(buf);
  if (pdf.getTitle() !== 'Quarterly memo' || pdf.getPageCount() !== 1 || Math.round(pdf.getPage(0).getWidth()) !== 595) throw new Error(`${pdf.getTitle()} ${pdf.getPageCount()} ${pdf.getPage(0).getWidth()}`);
  const { execFileSync } = await import('node:child_process');
  let text = null;
  try { text = execFileSync('pdftotext', ['-', '-'], { input: buf }).toString(); } catch { /* not installed */ }
  if (text !== null && !/Quarterly memo[\s\S]*Sales grew in every region\./.test(text)) throw new Error(text);
});
await step('the PDF follows Page setup: its font, watermark and paper', async () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Terms of the offer.' }] }] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Offer terms', content })).body;
  const r = await api(page, 'PATCH', `/files/${doc.id}`, { page_setup: { size: 'letter', orientation: 'portrait', margin: 'normal', header: '', footer: '', numbers: false, watermark: 'DRAFT', font: 'Georgia' } });
  if (r.status >= 300) throw new Error(JSON.stringify(r));
  const b64 = await page.evaluate(async (id) => btoa(Array.from(new Uint8Array(await (await fetch(`/api/files/${id}/export?format=pdf`)).arrayBuffer()), (c) => String.fromCharCode(c)).join('')), doc.id);
  const buf = Buffer.from(b64, 'base64');
  const { PDFDocument } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
  const pdf = await PDFDocument.load(buf);
  if (Math.round(pdf.getPage(0).getWidth()) !== 612) throw new Error('Letter paper: ' + pdf.getPage(0).getWidth());
  const { execFileSync } = await import('node:child_process');
  const f = `${SP}/offer-terms.pdf`;
  fs.writeFileSync(f, buf);
  let fonts = null, text = null;
  try { fonts = execFileSync('pdffonts', [f]).toString(); text = execFileSync('pdftotext', [f, '-']).toString(); } catch { /* not installed */ }
  if (fonts !== null && (!/Times-Roman/.test(fonts) || !text.replace(/\s+/g, '').includes('DRAFT') || !text.includes('Terms of the offer.'))) throw new Error(fonts + text);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
