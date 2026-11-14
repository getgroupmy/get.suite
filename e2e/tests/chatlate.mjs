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
await step('chat: a direct message with someone whose day is over says so; Send when their day starts schedules what you wrote', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const kimId = r.body.id;
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  const today = new Date().getUTCDay();
  const h = await api(kim, 'PUT', '/users/me/work-hours', { hours: { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today), start: 0, end: 1440, tz: 'UTC' } });
  if (h.status !== 200) throw new Error(`hours ${h.status}`);
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  const note = page.locator('.chat-late');
  await note.getByText(/It's \d\d:\d\d for/).waitFor({ timeout: 10000 });
  const btn = note.getByRole('button', { name: /Send when their day starts/ });
  if (!(await btn.isDisabled())) throw new Error('enabled with nothing written');
  await page.getByRole('textbox', { name: 'Message' }).fill('Can we talk about the launch tomorrow?');
  await page.screenshot({ path: `${SP}/shots/chat-late.png` });
  await btn.click();
  await page.getByText(/Scheduled for/).waitFor();
  await page.getByText(/1 scheduled message/).waitFor();
  const tomorrow = new Date(); tomorrow.setUTCHours(24, 0, 0, 0);
  const list = (await api(page, 'GET', `/chat/scheduled?channel=${dm}`)).body;
  if (list.length !== 1 || list[0].send_at !== tomorrow.getTime()) throw new Error(JSON.stringify(list).slice(0, 200));
  // Not in a channel.
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'late-room' })).body.id;
  await page.goto(`${B}/chat/${ch}`);
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  await page.waitForTimeout(600);
  if (await note.count()) throw new Error('shown in a channel');
});
await step('chat: @mentioning someone whose day is over says so above the box; not once the mention is gone', async () => {
  const gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${gen}`);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('@kim@acme.com can you look at this tomorrow?');
  const hint = page.getByRole('status', { name: 'Mentioned people who are away' });
  await hint.getByText('Kim Park').waitFor({ timeout: 10000 });
  await hint.getByText(/it's \d\d:\d\d for them, outside their working hours/).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-mention-late.png` });
  await box.fill('never mind');
  await hint.waitFor({ state: 'detached', timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
