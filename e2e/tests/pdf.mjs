import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const text = async (k) => (await cell(k).innerText()).trim();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const typeIn = async (k, s) => { await cell(k).click(); await page.keyboard.type(s); await page.keyboard.press('Enter'); };
const { PDFDocument } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
const pdf = async (n, base) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([base + i, 200]); return Buffer.from(await d.save()).toString('base64'); };
const upload = (p, name, b64) => p.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);
const pagesOf = async (id) => { const b64 = await page.evaluate(async (i) => { const r = await fetch(`/api/files/${i}/raw`); const a = new Uint8Array(await r.arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); }, id); return (await PDFDocument.load(Buffer.from(b64, 'base64'))).getPages().map((p) => [Math.round(p.getWidth()), p.getRotation().angle]); };
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
  await upload(page, 'Contract.pdf', await pdf(2, 100));
  await upload(page, 'Annex.pdf', await pdf(3, 300));
  await upload(page, 'Signature.png', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgAOe4F+3cjr+0AAAAASUVORK5CYII=');
  await page.goto(`${B}/drive`);
  await page.getByLabel('Select Contract.pdf').waitFor();
});
await step('tick two PDFs and a picture, put them in order, combine', async () => {
  for (const n of ['Contract.pdf', 'Annex.pdf', 'Signature.png']) await page.getByLabel(`Select ${n}`).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Combine into PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Combine into one PDF' });
  const order = async () => (await d.getByRole('list', { name: 'Order' }).locator('li .grow').allInnerTexts()).join(',');
  const before = await order();
  // Contract first, then the signature, then the annex.
  while ((await order()).split(',')[0] !== 'Contract.pdf') await d.getByRole('button', { name: 'Move Contract.pdf up' }).click();
  while ((await order()).split(',')[2] !== 'Annex.pdf') await d.getByRole('button', { name: 'Move Annex.pdf down' }).click();
  if ((await order()) !== 'Contract.pdf,Signature.png,Annex.pdf') throw new Error(`${before} -> ${await order()}`);
  await d.getByLabel('Name of the new PDF').fill('Signed contract');
  await page.screenshot({ path: `${SP}/shots/pdf-combine.png` });
  await d.getByRole('button', { name: 'Combine' }).click();
  await page.getByText('Made “Signed contract.pdf”').waitFor();
  await page.getByLabel('Select Signed contract.pdf').waitFor();
  const made = (await api(page, 'GET', '/files')).body;
  const list = made.files || made;
  const f = list.find((x) => x.name === 'Signed contract.pdf');
  const pages = await pagesOf(f.id);
  if (JSON.stringify(pages.map((p) => p[0])) !== JSON.stringify([100, 101, 842, 300, 301, 302])) throw new Error(JSON.stringify(pages));
});
await step('extract pages from a PDF, turned', async () => {
  await page.getByLabel('Actions for Annex.pdf').click();
  await page.getByRole('menuitem', { name: 'Extract pages…' }).click();
  const d = page.getByRole('dialog', { name: 'Extract pages from “Annex.pdf”' });
  await d.getByText('It has 3 pages.').waitFor();
  await d.getByLabel('Pages (like 1-3, 5, 8-)').fill('9');
  await d.getByRole('button', { name: 'Make new PDF' }).click();
  await page.getByText(/has 3 pages: 9 isn’t in it/).first().waitFor();
  await d.getByLabel('Pages (like 1-3, 5, 8-)').fill('3, 1');
  await d.getByLabel('Turn them').selectOption('90');
  await d.getByRole('button', { name: 'Make new PDF' }).click();
  await page.getByText('Made “Annex (pages 3,1).pdf”').waitFor();
  const list = (await api(page, 'GET', '/files')).body;
  const f = (list.files || list).find((x) => x.name === 'Annex (pages 3,1).pdf');
  const pages = await pagesOf(f.id);
  if (JSON.stringify(pages) !== JSON.stringify([[302, 90], [300, 90]])) throw new Error(JSON.stringify(pages));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
