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
let deck;
const deckNow = async () => (await api(page, 'GET', `/files/${deck.id}/content`)).body.content;
await step('turn on slide numbers (all but the first); a colleague sees them live', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Numbers' })).body;
  const cur = (await api(page, 'GET', `/files/${deck.id}/content`)).body;
  await api(page, 'PUT', `/files/${deck.id}/content`, { version: cur.file.version, content: { ...cur.content, slides: [...cur.content.slides, { id: 's2', items: [] }, { id: 's3', items: [] }] } });
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${deck.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await page.goto(`${B}/slides/${deck.id}`);
  await kim.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Slide 3', exact: true }).waitFor();
  await kim.getByRole('button', { name: 'Slide 3', exact: true }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Slide numbers: all but the first' }).click();
  await until(async () => (await deckNow()).numbers === 'skip-first', 15000);
  const stage = page.locator('.slide-stage');
  if (await stage.getByLabel(/^Slide number/).count()) throw new Error('number on the first slide');
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await stage.getByLabel('Slide number 2').waitFor();
  await kim.getByRole('button', { name: 'Slide 3', exact: true }).click();
  await kim.locator('.slide-stage').getByLabel('Slide number 3').waitFor();
});
await step('the PowerPoint download has slide numbers', async () => {
  const back = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export`)).arrayBuffer().then((b) => b.byteLength), deck.id);
  if (back < 1000) throw new Error('no file');
  const has = await page.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}/export`); const buf = new Uint8Array(await r.arrayBuffer());
    return new TextDecoder('latin1').decode(buf).includes('slide2.xml');
  }, deck.id);
  if (!has) throw new Error('not a deck');
});
await step('presenting: the number shows, and L turns on a laser pointer that follows the mouse', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Present' }).click();
  const pres = page.getByRole('dialog', { name: 'Presenting' });
  await pres.getByLabel('Slide number 2').waitFor();
  await page.keyboard.press('l');
  await page.mouse.move(400, 300);
  const dot = pres.getByRole('img', { name: 'Laser pointer' });
  await dot.waitFor();
  await until(async () => { const b = await dot.boundingBox(); return b && Math.abs(b.x + b.width / 2 - 400) < 3 && Math.abs(b.y + b.height / 2 - 300) < 3; });
  await page.keyboard.press('L');
  await until(async () => !(await dot.count()));
  await page.keyboard.press('Escape');
});
await step('turning them off', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Slide numbers: off' }).click();
  await until(async () => !(await deckNow()).numbers, 15000);
  await until(async () => !(await kim.locator('.slide-stage').getByLabel(/^Slide number/).count()));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
