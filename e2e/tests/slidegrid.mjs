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
let deck;
const order = async () => (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides.map((s) => s.items[0]?.text).join(',');
const text = (t) => ({ id: `t${t}`, type: 'text', text: t, x: 10, y: 10, w: 80, h: 20, size: 40 });
await step('grid view shows every slide; drag one to the front', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch', content: { theme: 'light', slides: ['S1', 'S2', 'S3', 'S4', 'S5'].map((t, i) => ({ id: `s${i + 1}`, items: [text(t)] })) } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: '⊞ Grid view' }).click();
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 5' }).waitFor();
  await g.getByRole('listitem').nth(4).dragTo(g.getByRole('listitem').nth(0), { targetPosition: { x: 5, y: 40 } });
  await until(async () => (await order()) === 'S5,S1,S2,S3,S4');
});
await step('choose several, then duplicate, skip and delete them together', async () => {
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 2' }).click();
  await g.getByRole('button', { name: 'Slide 3' }).click({ modifiers: ['Control'] });
  await page.getByText('2 slides selected').waitFor();
  const bar = page.getByRole('toolbar', { name: 'Selected slides' });
  await bar.getByRole('button', { name: 'Duplicate' }).click();
  await until(async () => (await order()) === 'S5,S1,S2,S1,S2,S3,S4');
  await bar.getByRole('button', { name: 'Skip / show' }).click(); // the copies (now chosen)
  await until(async () => { const s = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides; return s[3].skip && s[4].skip && !s[1].skip; });
  await bar.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete 2 slides?' }).getByRole('button', { name: 'Delete' }).click();
  await until(async () => (await order()) === 'S5,S1,S2,S3,S4');
});
await step('several dragged at once keep their order', async () => {
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 1' }).click();
  await g.getByRole('button', { name: 'Slide 2' }).click({ modifiers: ['Shift'] });
  await g.getByRole('listitem').nth(0).dragTo(g.getByRole('listitem').nth(4), { targetPosition: { x: 200, y: 40 } });
  await until(async () => (await order()) === 'S2,S3,S4,S5,S1');
});
await step('double-click opens a slide; the side list can be dragged too', async () => {
  await page.getByRole('list', { name: 'All slides' }).getByRole('button', { name: 'Slide 3' }).dblclick();
  await page.getByText('Slide 3 of 5').waitFor();
  const side = page.getByRole('list', { name: 'Slides' });
  await side.getByRole('listitem').nth(4).dragTo(side.getByRole('listitem').nth(0), { targetPosition: { x: 40, y: 3 } });
  await until(async () => (await order()) === 'S1,S2,S3,S4,S5');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
