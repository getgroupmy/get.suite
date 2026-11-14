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
const fs = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const pixel = async (bytes, x, y) => page.evaluate(async ([b64, x, y]) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, rgb: [...g.getImageData(x, y, 1, 1).data].slice(0, 3) };
}, [bytes.toString('base64'), x, y]);
let deck;
await step('Download this slide as a picture: a 1600 × 900 PNG of the slide as it looks', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Launch deck', content: { theme: 'ocean', slides: [
    { id: 's1', items: [{ id: 't1', type: 'text', x: 10, y: 10, w: 80, h: 20, text: 'Launch plan', size: 60, bold: true }, { id: 'r', type: 'shape', shape: 'rect', x: 70, y: 60, w: 20, h: 30, fill: '#ff0000' }] },
    { id: 's2', bg: '#00aa00', items: [{ id: 't2', type: 'text', x: 10, y: 10, w: 80, h: 15, text: 'Timeline', size: 40 }] },
  ] } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('menuitem', { name: 'Download this slide as a picture (.png)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch deck - 1.png') throw new Error(dl.suggestedFilename());
  const png = fs.readFileSync(await dl.path());
  const bg = await pixel(png, 400, 800), shape = await pixel(png, 1280, 680);
  if (bg.w !== 1600 || bg.h !== 900) throw new Error(`${bg.w}×${bg.h}`);
  if (bg.rgb.join() !== '11,87,208') throw new Error(`background ${bg.rgb}`); // the ocean theme
  if (shape.rgb.join() !== '255,0,0') throw new Error(`shape ${shape.rgb}`);
  fs.copyFileSync(await dl.path(), `${SP}/shots/slide-1.png`);
});
await step('Download all slides as pictures: a .zip with one PNG per slide', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('menuitem', { name: 'Download all slides as pictures (.zip)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch deck slides.zip') throw new Error(dl.suggestedFilename());
  const list = execFileSync('unzip', ['-Z1', await dl.path()]).toString().trim().split('\n');
  if (list.join('|') !== 'Launch deck - 1.png|Launch deck - 2.png') throw new Error(list.join('|'));
  execFileSync('unzip', ['-q', '-t', await dl.path()]);
  const second = execFileSync('unzip', ['-p', await dl.path(), 'Launch deck - 2.png']);
  const p = await pixel(second, 800, 800);
  if (p.rgb.join() !== '0,170,0') throw new Error(`slide 2 background ${p.rgb}`);
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
