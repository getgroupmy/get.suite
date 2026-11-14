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
let deckId;
const box = (id, text, x, y, w, h) => ({ id, type: 'text', text, x, y, w, h, size: 24 });
const item = (txt) => page.locator('.slide.editable').getByText(txt, { exact: true });
const saved = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].items;
await step('drag a box near the middle: a guide shows and it snaps to the centre', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Guides', content: { theme: 'light', slides: [{ id: 's1', items: [box('a', 'Alpha', 10, 10, 20, 10), box('b', 'Beta', 60, 60, 20, 10)] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Alpha').waitFor();
  const slide = await page.locator('.slide.editable').boundingBox();
  const a = await item('Alpha').boundingBox();
  // Alpha's centre is at x=20%: move it by 29.4% so it lands at 49.4% (near the middle).
  const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + slide.width * 0.294, sy + slide.height * 0.033, { steps: 8 });
  await page.locator('.slide-guide.x').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/guides.png` });
  await page.mouse.up();
  await until(async () => { const it = (await saved()).find((x) => x.id === 'a'); return Math.abs(it.x - 40) < 0.01; });
  if (await page.locator('.slide-guide').count()) throw new Error('guides should go after the drag');
});
await step('it lines up with another box\'s edge; Alt turns snapping off', async () => {
  const slide = await page.locator('.slide.editable').boundingBox();
  const a = await item('Alpha').boundingBox();
  // Alpha's left edge is at 40%: move it right by 20.6% → 60.6%, near Beta's left edge (60%).
  const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + slide.width * 0.206, sy, { steps: 8 });
  await page.mouse.up();
  await until(async () => Math.abs((await saved()).find((x) => x.id === 'a').x - 60) < 0.01);
  const b = await item('Alpha').boundingBox();
  const tx = b.x + b.width / 2, ty = b.y + b.height / 2;
  await page.keyboard.down('Alt');
  await page.mouse.move(tx, ty); await page.mouse.down();
  await page.mouse.move(tx - slide.width * 0.5 - 3, ty, { steps: 8 }); // centre lands just off the middle line
  if (await page.locator('.slide-guide').count()) throw new Error('no guides with Alt');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await until(async () => { const x = (await saved()).find((i) => i.id === 'a').x; return x < 10.9 && Math.abs(x - 10) > 0.05; });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
