import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
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
await step('record a voice message and send it; Kim plays it', async () => {
  await page.context().grantPermissions(['microphone']);
  await page.goto(`${B}/chat/${dm}`);
  await page.getByLabel('Message', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Record a voice message' }).click();
  await page.getByRole('status', { name: 'Recording' }).getByText('0:02').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  const pending = page.getByRole('list', { name: 'Files to send' });
  await pending.getByLabel(/Recording: Voice message 0\.0\d\.weba/).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const audio = kim.getByLabel('Voice message from Olivia Owner');
  await audio.waitFor();
  await kim.waitForFunction(() => { const a = document.querySelector('audio.msg-voice'); return a && a.readyState >= 1; }, null, { timeout: 15000 });
  const msgs = (await api(kim, 'GET', `/chat/channels/${dm}/messages`)).body;
  const list = msgs.messages || msgs;
  const last = list[list.length - 1];
  if (!last.files?.[0] || last.files[0].mime !== 'audio/webm') throw new Error(JSON.stringify(last).slice(0, 300));
}, kim);
await step('a recording can be thrown away instead', async () => {
  await page.getByRole('button', { name: 'Record a voice message' }).click();
  await page.getByRole('button', { name: 'Cancel recording' }).click();
  await page.waitForTimeout(800);
  if (await page.getByRole('list', { name: 'Files to send' }).count()) throw new Error('kept');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
