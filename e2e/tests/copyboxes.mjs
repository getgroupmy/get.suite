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
const slidesOf = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides;
await step('Ctrl+C, Ctrl+V: a copy lands a little down and right, chosen', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Copies', content: { theme: 'light', slides: [{ id: 's1', items: [box('a', 'Alpha', 10, 10, 20, 10), box('b', 'Beta', 50, 50, 20, 10)] }, { id: 's2', items: [] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Alpha').click();
  await page.keyboard.press('Control+c');
  await page.getByText('Copied 1 box').waitFor();
  await page.keyboard.press('Control+v');
  await until(async () => { const it = (await slidesOf())[0].items; return it.length === 3 && it[2].text === 'Alpha' && it[2].x === 12 && it[2].y === 12; });
  await page.getByLabel('Rotation').waitFor(); // the copy is chosen
});
await step('two boxes copied to the next slide keep their places; Ctrl+D duplicates; Ctrl+X cuts', async () => {
  await item('Beta').click({ modifiers: ['Shift'] });
  await page.getByText('2 boxes', { exact: true }).waitFor();
  await page.keyboard.press('Control+c');
  await page.getByText('Copied 2 boxes').waitFor();
  await page.locator('.slide-thumbs li, .slide-list li').nth(1).click().catch(() => {});
  await page.keyboard.press('PageDown').catch(() => {});
  await page.getByText('Slide 2 of 2').waitFor();
  await page.keyboard.press('Control+v');
  await until(async () => { const it = (await slidesOf())[1].items; return it.length === 2 && it.some((x) => x.text === 'Beta' && x.x === 50); });
  await page.getByText('2 boxes', { exact: true }).waitFor();
  await page.keyboard.press('Control+d');
  await until(async () => (await slidesOf())[1].items.length === 4);
  await page.keyboard.press('Control+x');
  await page.getByText('Cut 2 boxes').waitFor();
  await until(async () => (await slidesOf())[1].items.length === 2);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
