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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
let kim, dm;
const msg = (p, text) => p.locator('.msg', { hasText: text }).last();
await step('setup: a direct conversation', async () => {
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
  const dir = (await api(page, 'GET', '/users/directory')).body;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: dir.find((u) => u.username === 'kim@acme.com').id })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${dm}`);
  await kim.getByLabel('Message', { exact: true }).waitFor();
});
import http from 'node:http';
const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><meta property="og:title" content="Acme supplier portal"><meta property="og:description" content="Order parts and track deliveries."><meta property="og:site_name" content="Acme Supplies"></head></html>'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const link = `http://127.0.0.1:${site.address().port}/portal`;
await step('a link in a message gets its page\'s title and description, for everyone', async () => {
  await page.goto(`${B}/chat/${dm}`);
  await page.getByLabel('Message', { exact: true }).fill(`Here's the portal: ${link}`);
  await page.keyboard.press('Enter');
  const card = kim.getByRole('link', { name: 'Link: Acme supplier portal' });
  await card.waitFor({ timeout: 15000 });
  await card.getByText('Order parts and track deliveries.').waitFor();
  await card.getByText('Acme Supplies').waitFor();
  if ((await card.getAttribute('href')) !== link || !/noopener/.test(await card.getAttribute('rel'))) throw new Error('link');
  await page.getByRole('link', { name: 'Link: Acme supplier portal' }).waitFor();
}, kim);
site.close();
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
