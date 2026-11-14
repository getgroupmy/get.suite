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
let ch, url;
await step('add a webhook to a channel; its address is shown once', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'alerts' })).body.id;
  await page.goto(`${B}/chat/${ch}`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const hooks = page.getByRole('region', { name: 'Webhooks' });
  await hooks.getByLabel('Webhook name').fill('Uptime monitor');
  await hooks.getByRole('button', { name: 'Add webhook' }).click();
  url = await hooks.getByLabel('Webhook address').inputValue();
  if (!/\/hooks\/chat\/[\w-]{32}$/.test(url)) throw new Error(url);
  await hooks.getByText('Uptime monitor').first().waitFor();
  await hooks.getByText('not used yet').waitFor();
  await page.keyboard.press('Escape');
});
await step('a script posts with just the address; everyone sees it live, marked as an app', async () => {
  await kim.goto(`${B}/chat/${ch}`);
  await kim.getByLabel('Message', { exact: true }).waitFor();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Website is down! https://example.com' }) });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  await kim.getByText('Website is down!').waitFor();
  const msg = kim.locator('.msg', { hasText: 'Website is down!' });
  await msg.getByText('Uptime monitor').waitFor();
  await msg.getByText('App', { exact: true }).waitFor();
  await page.getByText('Website is down!').waitFor();
});
await step('removing it stops the address working', async () => {
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const hooks = page.getByRole('region', { name: 'Webhooks' });
  await hooks.getByText(/last used/).waitFor();
  await hooks.getByRole('button', { name: 'Remove webhook Uptime monitor' }).click();
  await until(async () => !(await hooks.getByText('Uptime monitor').count()));
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'still there?' });
  if (r.status !== 404) throw new Error(`status ${r.status}`);
  // Kim (not the channel's maker) can't see or add them.
  if ((await api(kim, 'GET', `/chat/channels/${ch}/webhooks`)).status !== 403) throw new Error('kim sees webhooks');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
