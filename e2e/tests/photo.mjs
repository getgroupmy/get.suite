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
let ch, kim;
await step('setup: a channel with a message from Olivia, and Kim', async () => {
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
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Hello from Olivia' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${ch}`);
  await kim.getByText('Hello from Olivia').waitFor();
  if (await kim.locator('.msg img.avatar').count()) throw new Error('no photo yet');
});
await step('Olivia adds a photo in Settings: it shows on her account button, and live in Kim’s chat', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Photo file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await page.getByText('Photo saved').waitFor();
  await page.getByRole('button', { name: 'Remove photo' }).waitFor();
  await page.getByRole('button', { name: 'Account' }).locator('img.avatar').waitFor();
  const msg = kim.locator('.msg', { hasText: 'Hello from Olivia' });
  await msg.locator('img.avatar').waitFor();
  const size = await msg.locator('img.avatar').evaluate((el) => [el.naturalWidth, el.naturalHeight].join('x'));
  if (size !== '256x256') throw new Error('square, made in the browser: ' + size);
  await kim.screenshot({ path: `${SP}/shots/photo-chat.png` });
});
await step('in the directory too; removing it brings the initials back', async () => {
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Directory' }).click();
  await kim.locator('tr', { hasText: 'Olivia Owner' }).locator('img.avatar').waitFor();
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await page.getByText('Photo removed').waitFor();
  await until(async () => (await kim.locator('tr', { hasText: 'Olivia Owner' }).locator('img.avatar').count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
