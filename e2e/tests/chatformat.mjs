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
let ch, first, kim;
await step('setup: an old message far up a busy channel, and a colleague', async () => {
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
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  first = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Wifi password: on the fridge' })).body;
  await page.evaluate(async (id) => { for (let i = 0; i < 110; i++) await fetch(`/api/chat/channels/${id}/messages`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ body: `chatter ${i}` }) }); }, ch);
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Lunch is at 1pm today' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await p.getByText('Lunch is at 1pm today').waitFor(); }
});
await step('typed formatting shows as bold, italic, strike, code and quotes', async () => {
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('Please *review* the _draft_ by ~Friday~ Monday, run `npm test` first');
  await box.press('Enter');
  const m = page.locator('.msg', { hasText: 'Please' }).last();
  await m.locator('strong', { hasText: 'review' }).waitFor();
  await m.locator('em', { hasText: 'draft' }).waitFor();
  await m.locator('s', { hasText: 'Friday' }).waitFor();
  await m.locator('code.msg-inline-code', { hasText: 'npm test' }).waitFor();
  await box.fill('```\nconst total = a * b * c;\n```');
  await box.press('Enter');
  await page.locator('pre.msg-code', { hasText: 'const total = a * b * c;' }).waitFor();
  await box.fill('> The client said *yes*\nGreat news');
  await box.press('Enter');
  await page.locator('blockquote.msg-quote strong', { hasText: 'yes' }).waitFor();
  await kim.locator('blockquote.msg-quote', { hasText: 'The client said yes' }).waitFor();
});
await step('ordinary text, links and mentions are untouched', async () => {
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('2 * 3 * 4 = 24, see https://example.com/a_b_c and ask @kim@acme.com about file_name_v2');
  await box.press('Enter');
  const m = page.locator('.msg', { hasText: '2 * 3 * 4 = 24' }).last();
  await m.waitFor();
  if (await m.locator('strong, em, s, code').count()) throw new Error('formatted plain text');
  const href = await m.locator('a[href^="https://example.com"]').getAttribute('href');
  if (href !== 'https://example.com/a_b_c') throw new Error(href);
  await m.locator('.mention', { hasText: '@kim@acme.com' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-format.png` });
});
await step('no HTML gets through', async () => {
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('*<img src=x onerror=alert(1)>* and `<b>tag</b>`');
  await box.press('Enter');
  const m = page.locator('.msg', { hasText: 'onerror' }).last();
  await m.waitFor();
  if (await m.locator('img, b').count()) throw new Error('markup rendered');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
