import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let pic;
const zlib = await import('node:zlib');
const crc32 = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
const W = 200, H = 100;
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H, 0x88); for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
await step('a picture in Drive', async () => {
  pic = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=logo.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/png' }, body: bin });
    return r.json();
  }, png.toString('base64'));
});
await step('comment on the whole file, and on a spot of the picture', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('row', { name: /logo\.png/ }).dblclick();
  const d = page.getByRole('dialog', { name: 'logo.png' });
  await d.getByRole('button', { name: 'Comments' }).click();
  await d.getByRole('button', { name: 'Comment on the file' }).click();
  await d.getByLabel('New comment').fill('Is this the final logo?');
  await d.getByRole('button', { name: 'Comment', exact: true }).click();
  await d.getByText('Is this the final logo?').waitFor();
  await d.getByRole('button', { name: 'Comment on a spot' }).click();
  const img = d.locator('.preview-pic img');
  const box = await img.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await d.getByLabel('New comment').fill('Too dark here');
  await d.getByRole('button', { name: 'Comment', exact: true }).click();
  await d.getByRole('button', { name: 'Comment 1' }).waitFor();
  const list = (await api(page, 'GET', `/comments/${pic.id}`)).body;
  const spot = list.find((c) => c.body === 'Too dark here');
  if (!(spot.anchor.x > 15 && spot.anchor.x < 35 && spot.anchor.y > 65 && spot.anchor.y < 85)) throw new Error(JSON.stringify(spot.anchor));
  await d.getByRole('button', { name: /Comments \(2\)/ }).waitFor();
});
await step('a link to a comment opens the preview with it', async () => {
  const id = (await api(page, 'GET', `/comments/${pic.id}`)).body.find((c) => c.body === 'Too dark here').id;
  await page.goto(`${B}/drive?preview=${pic.id}&comment=${id}`);
  const d = page.getByRole('dialog', { name: 'logo.png' });
  await d.getByRole('complementary', { name: 'Comments' }).getByText('Too dark here').waitFor();
  await d.locator('.comment-pin.on').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
