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
await step('drag the round handle: the box turns in 15° steps and stays turned', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Turns', content: { theme: 'light', slides: [{ id: 's1', items: [box('a', 'Alpha', 30, 30, 30, 20)] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Alpha').click();
  const h = page.locator('.handle.rot');
  await h.waitFor();
  const a = await page.locator('.slide.editable [data-item="a"]').boundingBox();
  const cx = a.x + a.width / 2, cy = a.y + a.height / 2;
  const hb = await h.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
  await page.mouse.move(cx + 100, cy - 98, { steps: 8 }); // about 45.6° → 45°
  await page.mouse.up();
  await until(async () => (await saved()).find((x) => x.id === 'a').rot === 45);
  const tf = await page.locator('.slide.editable [data-item="a"]').evaluate((el) => el.style.transform);
  if (tf !== 'rotate(45deg)') throw new Error(tf);
  if ((await page.getByLabel('Rotation').inputValue()) !== '45') throw new Error('toolbar shows it');
  await page.screenshot({ path: `${SP}/shots/rotate.png` });
});
await step('type an angle; 0 puts it upright; it shows when presenting', async () => {
  await page.getByLabel('Rotation').fill('-90');
  await until(async () => (await saved()).find((x) => x.id === 'a').rot === -90);
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await until(async () => (await page.locator('.presenter [data-item="a"], .present [data-item="a"], [data-item="a"]').last().evaluate((el) => el.style.transform)) === 'rotate(-90deg)');
  await page.keyboard.press('Escape');
  await item('Alpha').click();
  await page.getByLabel('Rotation').fill('0');
  await until(async () => (await saved()).find((x) => x.id === 'a').rot === undefined);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
