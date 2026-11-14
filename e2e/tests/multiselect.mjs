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
const at = async () => Object.fromEntries((await saved()).map((i) => [i.id, i]));
await step('Shift-click chooses several; they line up on their left edges', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Group', content: { theme: 'light', slides: [{ id: 's1', items: [box('a', 'Alpha', 10, 10, 20, 10), box('b', 'Beta', 40, 40, 10, 10), box('c', 'Gamma', 70, 20, 20, 10), box('z', 'Zed', 5, 80, 10, 8)] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Alpha').click();
  await item('Beta').click({ modifiers: ['Shift'] });
  await item('Gamma').click({ modifiers: ['Shift'] });
  await page.getByText('3 boxes').waitFor();
  await page.screenshot({ path: `${SP}/shots/multiselect.png` });
  await page.getByRole('button', { name: 'Align left edges' }).click();
  await until(async () => { const g = await at(); return g.a.x === 10 && g.b.x === 10 && g.c.x === 10 && g.z.x === 5; });
});
await step('space them evenly down, then drag them together', async () => {
  await page.getByRole('button', { name: 'Distribute down' }).click();
  await until(async () => { const g = await at(); return Math.abs(g.c.y - 25) < 0.01 && g.b.y === 40; }); // 10..50: tops 10, 25, 40 (sorted by y: a 10, c 20→25, b 40)
  const slide = await page.locator('.slide.editable').boundingBox();
  const b = await item('Beta').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + slide.width * 0.2, b.y + b.height / 2 + slide.height * 0.1, { steps: 6 });
  await page.mouse.up();
  await until(async () => { const g = await at(); return Math.abs(g.a.x - 30) < 0.2 && Math.abs(g.b.x - 30) < 0.2 && Math.abs(g.c.x - 30) < 0.2 && g.z.x === 5; });
  if (await page.getByText('3 boxes').count() !== 1) throw new Error('still chosen');
});
await step('Shift-click again takes one out; the arrow keys move the rest; a plain click picks one', async () => {
  await item('Gamma').click({ modifiers: ['Shift'] });
  await page.getByText('2 boxes').waitFor();
  const before = await at();
  await page.keyboard.press('ArrowRight');
  await until(async () => { const g = await at(); return Math.abs(g.a.x - before.a.x - 1) < 0.01 && Math.abs(g.b.x - before.b.x - 1) < 0.01 && g.c.x === before.c.x; });
  await item('Zed').click();
  if (await page.getByText(/\d boxes/).count()) throw new Error('back to one');
  await page.getByLabel('Rotation').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
