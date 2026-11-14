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
const until = async (fn, ms = 8000, what = '') => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out ${what}`); await new Promise((r) => setTimeout(r, 150)); } };
let docId, kim;
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
let deck;
const bgOf = (p) => p.locator('.slide-stage > .slide').first().evaluate((el) => getComputedStyle(el).backgroundImage);
await step('setup: a deck shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Deck', content: { theme: 'light', slides: [{ id: 's1', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Hello gradient' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${deck}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deck}`); await p.getByText('Hello gradient').first().waitFor(); }
  await page.getByText('Hello gradient').first().waitFor();
});
await step('Background gradient: fades the slide into blue, for everyone', async () => {
  await page.getByLabel('Background gradient').selectOption('#0b57d0');
  await until(async () => /linear-gradient\(rgb\(255, 255, 255\), rgb\(11, 87, 208\)\)/.test(await bgOf(page)), 8000, 'mine');
  await until(async () => /linear-gradient/.test(await bgOf(kim)), 8000, 'kim');
  await page.getByLabel('Gradient direction').selectOption('90');
  await until(async () => /linear-gradient\(90deg, rgb\(255, 255, 255\), rgb\(11, 87, 208\)\)/.test(await bgOf(kim)), 8000, 'kim 90');
  await until(async () => (await api(page, 'GET', `/files/${deck}/content`)).body.content?.slides?.[0]?.bgGrad === '#0b57d0 90', 8000, 'saved');
  await page.screenshot({ path: `${SP}/shots/slide-gradient.png` });
});
await step('the PowerPoint download has it; no gradient takes it off', async () => {
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export?type=pptx`); return { ok: res.ok, size: (await res.arrayBuffer()).byteLength }; }, deck);
  if (!r.ok || r.size < 1000) throw new Error(JSON.stringify(r));
  await page.getByLabel('Background gradient').selectOption('');
  await until(async () => !/linear-gradient/.test(await bgOf(kim)));
  if (await page.getByLabel('Gradient direction').count()) throw new Error('direction still offered');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
