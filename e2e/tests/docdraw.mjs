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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const drag = async (box, x0, y0, x1, y1) => { await page.mouse.move(box.x + x0, box.y + y0); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + x0 + (x1 - x0) * i / 8, box.y + y0 + (y1 - y0) * i / 8); await page.mouse.up(); };
let doc;
await step('Docs: ✎ Drawing draws a little diagram (boxes, an arrow, a scribble) and puts it in as a picture', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Process' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('How an order flows:');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Insert drawing' }).click();
  const d = page.getByRole('dialog', { name: 'Drawing' });
  if (!(await d.getByRole('button', { name: 'Insert' }).isDisabled())) throw new Error('can insert an empty drawing');
  const box = await d.getByLabel('Drawing area').boundingBox();
  await d.getByRole('radio', { name: /Box/ }).click();
  await drag(box, 30, 60, 230, 160);
  await drag(box, 450, 60, 650, 160);
  await d.getByRole('radio', { name: /Arrow/ }).click();
  await d.getByRole('button', { name: 'Ink Blue' }).click();
  await drag(box, 240, 110, 440, 110);
  await d.getByRole('radio', { name: /Ellipse/ }).click();
  await drag(box, 250, 200, 450, 280);
  // Undo takes the ellipse away again.
  await d.getByRole('button', { name: 'Undo' }).click();
  // What's drawn: red-free, with blue arrow pixels and dark box edges, and the middle of the ellipse area white.
  const px = await d.getByLabel('Drawing area').evaluate((c) => {
    const g = c.getContext('2d'); const k = c.width / c.getBoundingClientRect().width;
    const at = (x, y) => [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].slice(0, 3);
    return { arrow: at(340, 110), boxEdge: at(30, 110), ellipse: at(250, 240), inside: at(130, 110) };
  });
  if (px.arrow[2] < 150 || px.arrow[0] > 100) throw new Error('arrow ' + px.arrow);
  if (px.boxEdge[0] > 80) throw new Error('box edge ' + px.boxEdge);
  if (px.ellipse.some((v) => v < 240)) throw new Error('ellipse not undone ' + px.ellipse);
  if (px.inside.some((v) => v < 240)) throw new Error('boxes are outlines ' + px.inside);
  await d.screenshot({ path: `${SP}/shots/doc-drawing.png` });
  await d.getByRole('button', { name: 'Insert' }).click();
  await d.waitFor({ state: 'detached' });
  const img = page.locator('.ProseMirror img');
  await img.waitFor();
  if ((await img.getAttribute('alt')) !== 'Drawing') throw new Error('alt ' + await img.getAttribute('alt'));
  await until(async () => (await img.evaluate((i) => i.complete && i.naturalWidth)) === 1000);
  await page.keyboard.type('Then it ships.');
  await page.locator('.ProseMirror p', { hasText: 'Then it ships.' }).waitFor();
});
await step('the drawing is a picture file in Drive next to the document, and in the Word download', async () => {
  const files = (await api(page, 'GET', '/files')).body;
  if (!files.some((f) => f.name.startsWith('Drawing') && /png$/i.test(f.name))) throw new Error(files.map((f) => f.name).join(', '));
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] }; }, doc.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(Buffer.from(r.bytes));
  if (!Object.keys(zip.files).some((n) => /^word\/media\/.+\.png$/.test(n))) throw new Error('no picture in Word: ' + Object.keys(zip.files).filter((n) => /media/.test(n)).join(' ') + ' / ' + (await zip.file('word/document.xml').async('string')).match(/<w:t[^>]*>[^<]*<\/w:t>/g)?.join(''));
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
