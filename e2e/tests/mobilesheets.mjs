import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
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
const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const folded = async (tb, name, tool) => {
  if ((await tb.boundingBox()).height > 60) throw new Error(`${name} not folded`);
  if (await tb.getByRole('button', { name: tool }).isVisible()) throw new Error(`${name}: tools showing while folded`);
};
await step('a spreadsheet on a phone: formatting folded; type a figure and make it bold', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Phone budget' })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  const tb = page.getByRole('toolbar', { name: 'Cell formatting' });
  await tb.waitFor();
  await folded(tb, 'sheet toolbar', 'Bold');
  await page.locator('[data-k="A1"]').tap();
  await page.keyboard.type('1250');
  await page.keyboard.press('Enter');
  await page.locator('[data-k="A1"]').tap();
  await tb.getByRole('button', { name: 'Formatting ▾' }).click();
  await tb.getByRole('button', { name: 'Bold' }).click();
  await until(async () => (await page.locator('[data-k="A1"]').textContent()).includes('1250'), 10000);
  const weight = await page.locator('[data-k="A1"]').evaluate((el) => getComputedStyle(el.querySelector('*') || el).fontWeight);
  if (Number(weight) < 600 && weight !== 'bold') throw new Error(`not bold: ${weight}`);
  if (await over() > 2) throw new Error('wider than the screen');
  await page.screenshot({ path: `${SP}/shots/ms-sheet2.png` });
});
await step('a presentation on a phone: tools folded; add a slide', async () => {
  const sl = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Phone pitch' })).body;
  await page.goto(`${B}/slides/${sl.id}`);
  const tb = page.getByRole('toolbar', { name: 'Slide tools' });
  await tb.waitFor();
  await folded(tb, 'slide tools', 'Text box');
  await tb.getByRole('button', { name: 'Tools ▾' }).click();
  await tb.getByRole('button', { name: 'New slide' }).click();
  await page.getByRole('menuitem').first().click();
  await page.getByText('Slide 2 of 2').waitFor();
  if (await over() > 2) throw new Error('wider than the screen');
  await page.screenshot({ path: `${SP}/shots/ms-slides2.png` });
});
await step('look', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget' })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.waitForTimeout(2500);
  console.log('DBG sheet overflow', await over());
  await page.screenshot({ path: `${SP}/shots/ms-sheet.png` });
  const sl = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body;
  await page.goto(`${B}/slides/${sl.id}`);
  await page.waitForTimeout(2500);
  console.log('DBG slides overflow', await over());
  await page.screenshot({ path: `${SP}/shots/ms-slides.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
