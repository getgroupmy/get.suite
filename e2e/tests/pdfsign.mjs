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
const { PDFDocument, PDFName } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
const pdf = async (n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([595, 842]); return Buffer.from(await d.save()).toString('base64'); };
const upload = (p, name, b64) => p.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);
const pageBox = (i) => page.getByRole('group', { name: `Page ${i}`, exact: true });
const clickAt = async (i, fx, fy) => {
  for (let k = 0; k < 40; k++) { // wheel until the spot is well inside the window
    const b = await pageBox(i).boundingBox(), y = b.y + b.height * fy;
    if (y > 180 && y < 700) break;
    await page.mouse.move(b.x + 10, 400); await page.mouse.wheel(0, y >= 700 ? 150 : -150); await page.waitForTimeout(50);
  }
  const b = await pageBox(i).boundingBox(); await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
};
const ready = () => until(async () => (await page.locator('.pdf-sign-page canvas[data-ready]').count()) >= 2, 20000);
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
  await upload(page, 'Lease.pdf', await pdf(2));
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Lease.pdf').waitFor();
});
await step('open Fill & sign: the pages show', async () => {
  await page.getByLabel('Actions for Lease.pdf').click();
  await page.getByRole('menuitem', { name: 'Fill & sign…' }).click();
  await page.getByRole('dialog', { name: 'Fill & sign “Lease.pdf”' }).waitFor();
  await ready();
});
await step('place the date, a drawn signature and a tick; move one, remove one', async () => {
  await page.getByRole('button', { name: '📅 Date' }).click();
  await page.getByText('Click on a page to put the date there').waitFor();
  await clickAt(1, 0.3, 0.5);
  await page.getByLabel('Date on page 1').waitFor();
  // Drag it further down the page.
  const d = await page.getByLabel('Date on page 1').boundingBox();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2 + 100, { steps: 5 });
  await page.mouse.up();
  const after = await page.getByLabel('Date on page 1').boundingBox();
  if (Math.abs(after.y - d.y - 100) > 3) throw new Error(`moved ${after.y - d.y}`);
  await page.getByRole('button', { name: '✍ Signature' }).click();
  const sig = page.getByRole('dialog', { name: 'Your signature' });
  const pad = await sig.getByLabel('Draw your signature').boundingBox();
  await page.mouse.move(pad.x + 30, pad.y + 80); await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(pad.x + 30 + i * 12, pad.y + 80 + Math.sin(i / 2) * 30);
  await page.mouse.up();
  await sig.getByRole('button', { name: 'Use it' }).click();
  await clickAt(2, 0.7, 0.85);
  console.log('DBG', await page.evaluate(() => { const b = document.querySelectorAll('.pdf-sign-page')[1].getBoundingClientRect(); return JSON.stringify([b.top, b.height, document.querySelector('[role=status]')?.textContent, [...document.querySelectorAll('.pdf-sign-item')].map((x) => x.getAttribute('aria-label'))]); }));
  await page.getByLabel('Signature on page 2').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: '✓ Tick' }).click();
  await clickAt(2, 0.1, 0.1);
  await page.getByRole('button', { name: 'Remove tick' }).click();
  if (await page.getByLabel('Tick on page 2').count()) throw new Error('removed');
  await page.screenshot({ path: `${SP}/shots/pdf-sign.png` });
});
let signedId;
await step('save a signed copy beside it; the original is unchanged', async () => {
  await page.getByRole('button', { name: 'Save signed copy' }).click();
  await page.getByText('Saved “Lease (signed).pdf”').waitFor();
  const list = (await api(page, 'GET', '/files')).body;
  const files = list.files || list;
  signedId = files.find((f) => f.name === 'Lease (signed).pdf')?.id;
  if (!signedId) throw new Error('no signed copy');
  const raw = async (id) => Buffer.from(await page.evaluate(async (i) => { const a = new Uint8Array(await (await fetch(`/api/files/${i}/raw`)).arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); }, id), 'base64');
  const signed = await PDFDocument.load(await raw(signedId));
  const pics = signed.getPages().map((p) => { const x = p.node.Resources()?.lookup(PDFName.of('XObject')); return x ? x.keys().length : 0; });
  if (JSON.stringify(pics) !== '[1,1]') throw new Error(JSON.stringify(pics));
  const orig = await PDFDocument.load(await raw(files.find((f) => f.name === 'Lease.pdf').id));
  if (orig.getPages().some((p) => p.node.Resources()?.lookup(PDFName.of('XObject')))) throw new Error('original changed');
});
await step('the signature is drawn where it was put (seen in the signed copy)', async () => {
  await page.getByLabel('Actions for Lease (signed).pdf').click();
  await page.getByRole('menuitem', { name: 'Fill & sign…' }).click();
  await ready();
  // Ink (dark blue) around 70% across, 85% down page 2; none in the same spot on page 1.
  const inkNear = (i, fx, fy) => page.evaluate(([i, fx, fy]) => {
    const c = document.querySelectorAll('.pdf-sign-page canvas')[i - 1], g = c.getContext('2d');
    const w = Math.round(c.width * 0.16), h = Math.round(c.height * 0.06);
    const { data } = g.getImageData(Math.round(c.width * fx - w / 2), Math.round(c.height * fy - h / 2), w, h);
    let n = 0; for (let k = 0; k < data.length; k += 4) if (data[k] < 120 && data[k + 2] > 60 && data[k + 3] > 0) n++;
    return n;
  }, [i, fx, fy]);
  const there = await inkNear(2, 0.7, 0.85), not = await inkNear(1, 0.7, 0.85);
  if (there < 20 || not > 0) throw new Error(`ink ${there} / ${not}`);
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
