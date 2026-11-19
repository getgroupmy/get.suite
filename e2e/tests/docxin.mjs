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
await step('a Word file (saved by LibreOffice) opens with its alignment and colours', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/invite.docx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Invite.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  if (opened.status >= 300) throw new Error(JSON.stringify(opened));
  await page.goto(`${B}/docs/${opened.body.id}`);
  const ed = page.locator('.ProseMirror');
  await ed.getByText('Invitation').waitFor();
  const align = async (t) => ed.getByText(t, { exact: true }).evaluate((el) => getComputedStyle(el.closest('p, h1, h2, h3')).textAlign);
  if ((await align('Invitation')) !== 'center') throw new Error('heading ' + await align('Invitation'));
  if ((await align('The Events Team')) !== 'right') throw new Error('signature ' + await align('The Events Team'));
  const red = await ed.getByText('Friday', { exact: true }).evaluate((el) => getComputedStyle(el).color);
  if (red !== 'rgb(197, 34, 31)') throw new Error('colour ' + red);
  const mark = await ed.getByText('Dress code: smart', { exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
  if (mark !== 'rgb(255, 255, 0)') throw new Error('highlight ' + mark);
  await page.screenshot({ path: `${SP}/shots/docx-in.png` });
});
await step('pictures keep their size, place and alt text through a Word download and back, a horizontal line after them too', async () => {
  // A 400×200 PNG, made here.
  const zlib = await import('node:zlib');
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(400, 0); ih.writeUInt32BE(200, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc(1201 * 200, 0x60); for (let y = 0; y < 200; y++) raw[y * 1201] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  const pic = await page.evaluate(async (b) => (await fetch('/api/files/upload?name=chart.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/png' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) })).json(), png);
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Report' }] },
    { type: 'image', attrs: { fileId: pic.id, alt: 'Sales chart', width: '50%', align: 'center' } },
    { type: 'image', attrs: { fileId: pic.id, alt: 'Same chart, as it is' } },
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'text', text: 'The end' }] },
  ] } })).body;
  await page.goto(`${B}/docs/${d.id}`);
  await page.locator('.ProseMirror').getByText('The end').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download as Word/ }).click()]);
  const bytes = (await import('node:fs')).readFileSync(await dl.path()).toString('base64');
  const up = await page.evaluate(async (b) => (await fetch('/api/files/upload?name=Report%20(Word).docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) })).json(), bytes);
  await page.goto(`${B}/drive`);
  await page.getByText('Report (Word).docx').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Report (Word).docx' });
  await pv.getByRole('button', { name: 'Open as document' }).click({ timeout: 20000 });
  await page.waitForURL(/\/docs\//);
  const ed = page.locator('.ProseMirror');
  await ed.getByText('The end').waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  const kinds = (await api(page, 'GET', `/files/${id}/content`)).body.content.content.map((n) => (n.type === 'image' ? `image ${n.attrs.alt} ${n.attrs.width || 'own'} ${n.attrs.align || 'left'}` : n.type));
  if (JSON.stringify(kinds) !== JSON.stringify(['heading', 'image Sales chart 50% center', 'image Same chart, as it is own left', 'horizontalRule', 'paragraph'])) throw new Error(JSON.stringify(kinds));
  // On the page: the first picture half the page's width, in the middle.
  const img = ed.locator('img[alt="Sales chart"]');
  await img.waitFor();
  const box = await img.evaluate((el) => { const r = el.getBoundingClientRect(), p = el.closest('.ProseMirror').getBoundingClientRect(); return { w: r.width / p.width, mid: (r.left + r.width / 2 - p.left) / p.width }; });
  if (Math.abs(box.w - 0.5) > 0.06 || Math.abs(box.mid - 0.5) > 0.06) throw new Error(JSON.stringify(box));
  await ed.locator('hr').waitFor();
  if (up.id === id) throw new Error('not a copy');
  await page.screenshot({ path: `${SP}/shots/docx-pictures.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
