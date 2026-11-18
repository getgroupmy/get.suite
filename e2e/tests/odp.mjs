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
let deck;
await step('a presentation downloads as OpenDocument (.odp)', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Launch deck', content: { theme: 'ocean', slides: [
    { id: 's1', notes: 'Open with the numbers', items: [{ id: 't1', type: 'text', x: 10, y: 15, w: 80, h: 20, text: 'Launch plan', size: 60, bold: true, align: 'center' }, { id: 'sh', type: 'shape', shape: 'star', x: 70, y: 55, w: 15, h: 25, fill: '#ffd666', text: 'New' }] },
    { id: 's2', items: [{ id: 't2', type: 'text', x: 10, y: 10, w: 80, h: 15, text: 'Timeline', size: 40 }] },
  ] } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.odp)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch deck.odp') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await dl.path());
  if (bytes.subarray(30, 85).toString() !== 'mimetypeapplication/vnd.oasis.opendocument.presentation') throw new Error('not an .odp');
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Launch%20deck%20(Impress).odp', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
});
await step('a presentation downloads as plain text: each slide, its title and words, its notes', async () => {
  const content = { theme: 'light', slides: [
    { id: 'a', notes: 'Welcome everyone', items: [{ id: 't', type: 'text', role: 'title', x: 5, y: 5, w: 90, h: 15, text: 'Our plan' }, { id: 'b', type: 'text', x: 5, y: 30, w: 90, h: 40, text: '• Hire two people\n• Open a shop' }] },
    { id: 'c', skip: true, items: [{ id: 'tb', type: 'table', x: 5, y: 5, w: 60, h: 30, cells: [['Item', 'Cost'], ['Rent', '900']] }] },
  ] };
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Plan text', content })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await page.getByText('Our plan').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as plain text (.txt)' }).click()]);
  if (dl.suggestedFilename() !== 'Plan text.txt') throw new Error(dl.suggestedFilename());
  const txt = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (txt !== 'Slide 1: Our plan\n\n• Hire two people\n• Open a shop\n\nNotes: Welcome everyone\n\n\nSlide 2 (skipped)\n\nItem\tCost\nRent\t900\n') throw new Error(JSON.stringify(txt));
});
await step('a presentation downloads as PDF: a page a slide, skipped ones left out', async () => {
  const content = { theme: 'light', slides: [
    { id: 'a', items: [{ id: 't', type: 'text', role: 'title', x: 5, y: 5, w: 90, h: 15, text: 'Launch plan' }] },
    { id: 'b', skip: true, items: [{ id: 'h', type: 'text', x: 5, y: 5, w: 90, h: 15, text: 'Not shown' }] },
    { id: 'c', items: [{ id: 'tb', type: 'table', x: 5, y: 5, w: 60, h: 30, header: true, cells: [['Week', 'Goal'], ['1', 'Press']] }] },
  ] };
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Launch', content })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PDF (.pdf)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch.pdf') throw new Error(dl.suggestedFilename());
  const buf = (await import('node:fs')).readFileSync(await dl.path());
  const { PDFDocument } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
  const pdf = await PDFDocument.load(buf);
  if (pdf.getPageCount() !== 2 || pdf.getPage(0).getWidth() !== 960) throw new Error(`${pdf.getPageCount()} pages, ${pdf.getPage(0).getWidth()} wide`);
  if (pdf.getAuthor() !== 'Olivia Owner') throw new Error('author ' + pdf.getAuthor());
  let text = null;
  try { text = (await import('node:child_process')).execFileSync('pdftotext', ['-', '-'], { input: buf }).toString(); } catch { /* not installed */ }
  if (text !== null && (!text.includes('Launch plan') || !text.includes('Press') || text.includes('Not shown'))) throw new Error(text);
});
await step('in Drive an .odp file shows as a presentation and opens as one, notes and all', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Launch deck (Impress).odp').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Launch deck (Impress).odp' });
  await pv.getByText('Launch plan').first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SP}/shots/odp-preview.png` });
  await pv.getByRole('button', { name: 'Open as presentation' }).click();
  await page.waitForURL(/\/slides\//);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByText('New', { exact: true }).first().waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  const c = (await api(page, 'GET', `/files/${id}/content`)).body.content;
  if (c.slides.length !== 2 || c.slides[0].notes !== 'Open with the numbers' || c.slides[1].items[0].text !== 'Timeline') throw new Error(JSON.stringify(c).slice(0, 300));
  await page.screenshot({ path: `${SP}/shots/odp-opened.png` });
});
await step('a .pptx saved as .odp by LibreOffice opens with its title and plain text boxes, not coloured shapes', async () => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { console.log('(LibreOffice is not installed here: step skipped)'); return; }
  const fs = await import('node:fs'); const path = await import('node:path');
  await api(page, 'PUT', `/files/${deck.id}/content`, { version: (await api(page, 'GET', `/files/${deck.id}/content`)).body.file.version, content: { theme: 'light', slides: [
    { id: 's1', items: [{ id: 't1', type: 'text', role: 'title', x: 10, y: 10, w: 80, h: 20, text: 'Roadmap 2027', size: 44, bold: true }, { id: 't2', type: 'text', role: 'body', x: 10, y: 40, w: 60, h: 30, text: 'Ship the mobile app', size: 24 }] },
  ] } });
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Roadmap 2027').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download as PowerPoint/ }).click()]);
  const dir = fs.mkdtempSync(path.join(SP, 'lo-'));
  fs.copyFileSync(await dl.path(), path.join(dir, 'Roadmap.pptx'));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'odp', '--outdir', path.join(dir, 'out'), path.join(dir, 'Roadmap.pptx')], { stdio: 'ignore', timeout: 120000 });
  const bytes = fs.readFileSync(path.join(dir, 'out', 'Roadmap.odp'));
  fs.rmSync(dir, { recursive: true, force: true });
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Roadmap%20(from%20LibreOffice).odp', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
  await page.goto(`${B}/drive`);
  await page.getByText('Roadmap (from LibreOffice).odp').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Roadmap (from LibreOffice).odp' });
  await pv.getByRole('button', { name: 'Open as presentation' }).click({ timeout: 20000 });
  await page.waitForURL(/\/slides\//);
  await page.getByText('Ship the mobile app').first().waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  const items = (await api(page, 'GET', `/files/${id}/content`)).body.content.slides[0].items;
  const got = items.map((i) => `${i.type}:${i.role || ''}:${i.fill || ''}:${i.text}`).join(' | ');
  if (got !== 'text:title::Roadmap 2027 | text:::Ship the mobile app') throw new Error(got);
  await page.screenshot({ path: `${SP}/shots/odp-from-lo.png` });
});
await step('a chart on a slide goes out as a real chart and comes back as one, drawn', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Results' })).body;
  const c = (await api(page, 'GET', `/files/${d.id}/content`)).body;
  const data = { categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Sales', values: [4, 7, 9] }] };
  await api(page, 'PUT', `/files/${d.id}/content`, { version: c.file.version, content: { ...c.content, slides: [{ id: 's1', items: [{ id: 'ch', type: 'chart', chartType: 'line', title: 'Quarterly sales', data, x: 10, y: 10, w: 70, h: 70 }] }] } });
  const up = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=odp`)).arrayBuffer();
    return (await fetch('/api/files/upload?name=Results.odp', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, d.id);
  const opened = (await api(page, 'POST', `/files/${up.id}/open-as`)).body;
  const item = (await api(page, 'GET', `/files/${opened.id}/content`)).body.content.slides[0].items.find((it) => it.type === 'chart');
  if (!item || item.chartType !== 'line' || item.title !== 'Quarterly sales' || JSON.stringify(item.data) !== JSON.stringify(data)) throw new Error(JSON.stringify(item));
  await page.goto(`${B}/slides/${opened.id}`);
  await page.getByText('Quarterly sales').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/odp-chart.png` });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
