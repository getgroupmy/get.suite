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
const pdf = async (n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([400 + i * 10, 560]); return Buffer.from(await d.save()).toString('base64'); };
const upload = (p, name, b64) => p.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);
const pagesOf = async (id) => { const b64 = await page.evaluate(async (i) => { const a = new Uint8Array(await (await fetch(`/api/files/${i}/raw`)).arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); }, id); return (await PDFDocument.load(Buffer.from(b64, 'base64'))).getPages().map((p) => [Math.round(p.getWidth()), p.getRotation().angle]); };
let file;
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
  file = await upload(page, 'Scan.pdf', await pdf(4));
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Scan.pdf').waitFor();
});
const order = () => page.getByRole('list', { name: 'Pages' }).getByRole('listitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
await step('drag page 4 to the front, turn page 2, take out page 3, save as a new version', async () => {
  await page.getByLabel('Actions for Scan.pdf').click();
  await page.getByRole('menuitem', { name: 'Organise pages…' }).click();
  const d = page.getByRole('dialog', { name: 'Organise pages of “Scan.pdf”' });
  await until(async () => (await page.locator('.pdf-thumb canvas[data-ready]').count()) === 4, 20000);
  await d.getByRole('listitem', { name: 'Page 4' }).dragTo(d.getByRole('listitem', { name: 'Page 1' }));
  if ((await order()).join(',') !== 'Page 4,Page 1,Page 2,Page 3') throw new Error((await order()).join(','));
  await d.getByRole('button', { name: 'Turn page 2' }).click();
  await d.getByRole('button', { name: 'Take out page 3' }).click();
  if ((await order()).join(',') !== 'Page 4,Page 1,Page 2, turned 90°') throw new Error((await order()).join(','));
  await page.screenshot({ path: `${SP}/shots/pdf-organize.png` });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/has its pages as you set them/).waitFor();
  const pages = await pagesOf(file.id);
  if (JSON.stringify(pages) !== JSON.stringify([[430, 0], [400, 0], [410, 90]])) throw new Error(JSON.stringify(pages));
  const v = (await api(page, 'GET', `/files/${file.id}/versions`)).body;
  if (!((v.versions || v).length >= 1)) throw new Error('no version kept');
});
await step('save as a copy instead: the PDF stays as it is', async () => {
  await page.getByLabel('Actions for Scan.pdf').click();
  await page.getByRole('menuitem', { name: 'Organise pages…' }).click();
  const d = page.getByRole('dialog', { name: 'Organise pages of “Scan.pdf”' });
  await until(async () => (await page.locator('.pdf-thumb canvas[data-ready]').count()) === 3, 20000);
  await d.getByRole('button', { name: 'Move page 2 earlier' }).click();
  await d.getByRole('button', { name: 'Save as a copy' }).click();
  await page.getByText('Made “Scan (reorganised).pdf”').waitFor();
  const list = (await api(page, 'GET', '/files')).body;
  const copy = (list.files || list).find((f) => f.name === 'Scan (reorganised).pdf');
  if (JSON.stringify(await pagesOf(copy.id)) !== JSON.stringify([[400, 0], [430, 0], [410, 90]])) throw new Error('copy order');
  if (JSON.stringify(await pagesOf(file.id)) !== JSON.stringify([[430, 0], [400, 0], [410, 90]])) throw new Error('original changed');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
