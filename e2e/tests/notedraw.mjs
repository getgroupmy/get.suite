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
let note;
await step('draw on a note and add the drawing to it', async () => {
  note = (await api(page, 'POST', '/notes', { title: 'Office layout' })).body;
  await page.goto(`${B}/notes`);
  const card = page.getByRole('article', { name: 'Office layout' });
  await card.getByRole('button', { name: 'Draw' }).click();
  const d = page.getByRole('dialog', { name: 'Drawing' });
  if (!(await d.getByRole('button', { name: 'Add to note' }).isDisabled())) throw new Error('can add an empty drawing');
  await d.getByRole('button', { name: 'Ink Red' }).click();
  const box = await d.getByLabel('Drawing area').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 40 + i * 20, box.y + 40 + i * 10);
  await page.mouse.up();
  await d.getByRole('button', { name: 'Undo' }).click();
  await page.mouse.move(box.x + 60, box.y + 120); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 140, { steps: 8 }); await page.mouse.up();
  // A red pixel is on the pad.
  const red = await d.getByLabel('Drawing area').evaluate((c) => { const g = c.getContext('2d'); const d2 = g.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d2.length; i += 4) if (d2[i] > 180 && d2[i + 1] < 90 && d2[i + 2] < 90) return true; return false; });
  if (!red) throw new Error('nothing drawn');
  await d.getByRole('button', { name: 'Add to note' }).click();
  await page.getByText('Drawing added').waitFor();
  await until(async () => (await api(page, 'GET', '/notes')).body.find((n) => n.id === note.id)?.pictures.length === 1);
  const img = card.locator('.note-pictures img');
  await img.waitFor();
  const size = await img.evaluate((i) => (i.complete ? [i.naturalWidth, i.naturalHeight] : null));
  await until(async () => { const s = await img.evaluate((i) => [i.naturalWidth, i.naturalHeight]); return s[0] === 1000 && s[1] === 600; });
  if (!size && false) throw new Error('');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
