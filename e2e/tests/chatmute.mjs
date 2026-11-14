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
const chatBadge = (p) => p.locator('a.appnav-item[href="/chat"] .nav-badge');
await step('Kim mutes the busy channel', async () => {
  await kim.goto(`${B}/drive`);
  await kim.goto(`${B}/chat/${ch}`);
  await kim.getByRole('button', { name: 'Mute conversation' }).click();
  await kim.getByRole('menuitem', { name: 'Until I unmute' }).click();
  await kim.getByText('Muted: only mentions will add to your unread count').waitFor();
  await kim.locator('.subnav-item.muted', { hasText: 'office' }).getByLabel('Muted').waitFor();
  await kim.goto(`${B}/drive`);
  await until(async () => (await chatBadge(kim).count()) === 0);
});
await step('new messages there don’t add to the count; a mention does', async () => {
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'more chatter' });
  await kim.waitForTimeout(1500);
  if (await chatBadge(kim).count()) throw new Error('muted channel counted');
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'hey @kim@acme.com look' });
  await until(async () => (await chatBadge(kim).count()) === 1 && (await chatBadge(kim).innerText()) === '1');
  await kim.screenshot({ path: `${SP}/shots/mute.png` });
});
await step('unmuting counts everything again; others are unaffected', async () => {
  await kim.goto(`${B}/chat/${ch}`);
  await kim.getByRole('button', { name: 'Unmute conversation' }).click();
  await kim.getByRole('button', { name: 'Mute conversation' }).waitFor();
  const mine = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.id === ch);
  if (mine.muted) throw new Error('muted for Olivia too');
});
await step('mute for a while: it says until when, and ends by itself', async () => {
  await kim.goto(`${B}/chat/${ch}`);
  await kim.getByRole('button', { name: 'Mute conversation' }).click();
  const items = await kim.getByRole('menuitem').allInnerTexts();
  if (items.join('|') !== 'For 1 hour|For 8 hours|Until tomorrow morning|For a week|Until I unmute') throw new Error(items.join('|'));
  await kim.getByRole('menuitem', { name: 'For 1 hour' }).click();
  await kim.getByText(/^Muted until (today|tomorrow) at/).waitFor();
  const btn = kim.getByRole('button', { name: 'Unmute conversation' });
  if (!/until (today|tomorrow) at/.test(await btn.innerText())) throw new Error(await btn.innerText());
  const mine = (await api(kim, 'GET', '/chat/channels')).body.channels.find((c) => c.id === ch);
  if (Math.abs(mine.muted_until - Date.now() - 3600e3) > 60e3) throw new Error(String(mine.muted_until));
  // A short one ends while the conversation is open: the bell comes back by itself.
  const r = await api(kim, 'POST', `/chat/channels/${ch}/mute`, { until: Date.now() + 35e3 });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await kim.getByRole('button', { name: 'Mute conversation' }).waitFor({ timeout: 70000 });
  await kim.screenshot({ path: `${SP}/shots/mute-ended.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
