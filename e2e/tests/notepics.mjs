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
let note, kim, png;
await step('add a picture to a note from its card', async () => {
  png = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 100 } });
  note = (await api(page, 'POST', '/notes', { title: 'Whiteboard', body: 'From the planning session' })).body;
  await page.goto(`${B}/notes`);
  const card = page.getByRole('article', { name: 'Whiteboard' });
  await card.getByLabel('Picture to add').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: png });
  await card.locator('.note-pictures img').waitFor();
  const ok = await card.locator('.note-pictures img').evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!ok) throw new Error('picture not shown');
});
await step('a colleague it is shared with sees it; pictures can be removed in the open note', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'PUT', `/notes/${note.id}/shares`, { user_ids: [kimId] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/notes`);
  const card = kim.getByRole('article', { name: 'Whiteboard' });
  await card.locator('.note-pictures img').waitFor();
  if (!(await card.locator('.note-pictures img').evaluate((img) => img.complete && img.naturalWidth > 0))) throw new Error('Kim cannot see it');
  // Olivia opens the note, adds a second one, then removes the first.
  await page.getByRole('article', { name: 'Whiteboard' }).locator('.note-open').click();
  const d = page.getByRole('dialog', { name: 'Whiteboard' });
  await d.getByRole('list', { name: 'Pictures' }).getByRole('img', { name: 'Picture 1' }).waitFor();
  await d.getByLabel('Picture to add').setInputFiles({ name: 'two.png', mimeType: 'image/png', buffer: png });
  await d.getByRole('img', { name: 'Picture 2' }).waitFor();
  await d.getByRole('button', { name: 'Remove picture 1' }).click();
  await until(async () => (await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id)?.pictures.length === 1);
  // Kim's card shows both for a moment (the second arrived, the removal not yet): wait for just the one.
  await until(async () => (await kim.getByRole('article', { name: 'Whiteboard' }).locator('.note-pictures img').count()) === 1, 15000);
}, kim);
await step('only pictures are accepted', async () => {
  const r = await page.evaluate(async (id) => (await fetch(`/api/notes/${id}/pictures`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/html' }, body: '<b>x</b>' })).status, note.id);
  if (r !== 400) throw new Error(String(r));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
