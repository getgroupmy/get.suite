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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let src, deck;
const deckNow = async () => (await api(page, 'GET', `/files/${deck.id}/content`)).body.content;
await step('import two slides (one with a picture) from a colleague\'s presentation', async () => {
  const pic = await kim.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#d50000'; g.fillRect(0, 0, 40, 20);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return (await fetch('/api/files/upload?name=red.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: blob })).json();
  });
  src = (await api(kim, 'POST', '/files/new', { kind: 'slides', name: 'Kim deck' })).body;
  const cur = (await api(kim, 'GET', `/files/${src.id}/content`)).body;
  await api(kim, 'PUT', `/files/${src.id}/content`, { version: cur.file.version, content: { ...cur.content, slides: [
    { id: 'a', items: [{ id: 'a1', type: 'text', text: 'Kim intro', x: 10, y: 10, w: 80, h: 20, size: 32 }] },
    { id: 'b', items: [{ id: 'b1', type: 'text', text: 'Kim numbers', x: 10, y: 10, w: 80, h: 20, size: 32 }, { id: 'b2', type: 'image', fileId: pic.id, x: 30, y: 40, w: 40, h: 40 }] },
    { id: 'c', items: [{ id: 'c1', type: 'text', text: 'Kim thanks', x: 10, y: 10, w: 80, h: 20, size: 32 }] },
  ] } });
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  await api(kim, 'PUT', `/files/${src.id}/shares`, { shares: [{ user_id: me, role: 'viewer' }] });
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Review' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Slide 1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Import slides…' }).click();
  await page.getByRole('dialog', { name: 'Import slides from a presentation' }).getByRole('button', { name: /Kim deck/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Import slides from “Kim deck”' });
  await dlg.getByText('Kim numbers').waitFor();
  await dlg.getByLabel('Slide 2', { exact: true }).check();
  await dlg.getByLabel('Slide 3', { exact: true }).check();
  await dlg.getByRole('button', { name: 'Import 2 slides' }).click();
  await page.getByText('2 slides imported from “Kim deck”').waitFor();
  await page.getByRole('button', { name: 'Slide 3', exact: true }).waitFor();
  await until(async () => { const d = await deckNow(); return d.slides.length === 3 && d.slides[1].items[0].text === 'Kim numbers' && d.slides[2].items[0].text === 'Kim thanks'; }, 15000);
  // The picture shows: a copy that's Olivia's.
  await until(() => page.evaluate(() => [...document.querySelectorAll('.slide-stage img')].some((i) => i.naturalWidth > 0)), 10000);
  const img = (await deckNow()).slides[1].items.find((x) => x.type === 'image');
  const f = (await api(page, 'GET', `/files/${img.fileId}`)).body;
  if (f.name !== 'red.png' || img.fileId === (await api(kim, 'GET', `/files/${src.id}/content`)).body.content.slides[1].items[1].fileId) throw new Error(JSON.stringify(f));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
