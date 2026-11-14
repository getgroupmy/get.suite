import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
const pixel = async (bytes, pts) => page.evaluate(async ([b64, pts]) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const all = g.getImageData(0, 0, img.width, img.height).data;
  let blue = 0; for (let i = 0; i < all.length; i += 4) if (all[i] === 0x2a && all[i + 1] === 0x78 && all[i + 2] === 0xd6) blue++;
  return { w: img.width, h: img.height, corner: [...g.getImageData(pts[0], pts[1], 1, 1).data].slice(0, 3), blue };
}, [bytes.toString('base64'), pts]);
await step('a chart downloads as a 1200 × 700 picture in the light colours, even in dark mode', async () => {
  const s = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Sales', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Month', B1: 'Sales', A2: 'Jan', B2: '10', A3: 'Feb', B3: '25', A4: 'Mar', B4: '18' },
    charts: { c1: { id: 'c1', type: 'column', range: 'A1:B4', title: 'Sales by month', x: 300, y: 40, w: 420, h: 300 } } }] } })).body;
  await page.goto(`${B}/sheets/${s.id}`);
  await page.getByRole('region', { name: 'Chart: Sales by month' }).waitFor();
  await page.getByRole('button', { name: 'Options for chart Sales by month' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('menuitem', { name: 'Download as a picture (.png)' }).click()]);
  if (dl.suggestedFilename() !== 'Sales by month.png') throw new Error(dl.suggestedFilename());
  const png = fs.readFileSync(await dl.path());
  fs.copyFileSync(await dl.path(), `${SP}/shots/chart.png`);
  const p = await pixel(png, [5, 5]);
  if (p.w !== 1200 || p.h !== 700) throw new Error(`${p.w}×${p.h}`);
  if (p.corner.join() !== '255,255,255') throw new Error(`background ${p.corner}`);
  if (p.blue < 5000) throw new Error(`hardly any column colour: ${p.blue} pixels`);
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
