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
await step('pin a message from its hover actions; it is marked, for Kim too', async () => {
  const msg = page.locator('.msg', { hasText: 'Lunch is at 1pm today' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Pin message' }).click();
  await msg.getByText('📌 Pinned by Olivia Owner').waitFor();
  await kim.locator('.msg', { hasText: 'Lunch is at 1pm today' }).getByText('📌 Pinned by Olivia Owner').waitFor();
  await kim.getByRole('button', { name: 'Pinned messages (1)' }).waitFor();
});
await step('the pinned list shows them; clicking an old one jumps far back', async () => {
  await api(page, 'POST', `/chat/messages/${first.id}/pin`, {});
  await kim.getByRole('button', { name: 'Pinned messages (2)' }).click();
  const panel = kim.getByRole('dialog', { name: 'Pinned messages' });
  const items = await panel.locator('.pin-text').allInnerTexts();
  if (items.join('|') !== 'Wifi password: on the fridge|Lunch is at 1pm today') throw new Error(items.join('|'));
  await kim.screenshot({ path: `${SP}/shots/chat-pins.png` });
  await panel.getByText('Wifi password: on the fridge').click();
  const m = kim.locator(`[data-mid="${first.id}"]`);
  await m.waitFor();
  await until(async () => m.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top > 0 && r.bottom < window.innerHeight; }));
  if (await panel.count()) throw new Error('panel closes');
});
await step('Kim unpins one from the list; Olivia sees it go', async () => {
  await kim.getByRole('button', { name: 'Pinned messages (2)' }).click();
  const panel = kim.getByRole('dialog', { name: 'Pinned messages' });
  await panel.locator('li', { hasText: 'Lunch is at 1pm today' }).getByRole('button', { name: 'Unpin' }).click();
  await page.getByRole('button', { name: 'Pinned messages (1)' }).waitFor();
  await until(async () => (await page.locator('.msg', { hasText: 'Lunch is at 1pm today' }).getByText('📌 Pinned').count()) === 0);
});
await step('no pin button on thread replies', async () => {
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'In a thread', parent_id: first.id });
  await page.goto(`${B}/chat/${ch}?msg=${first.id}&thread=${first.id}`);
  const t = page.locator('.thread-body .msg', { hasText: 'In a thread' });
  await t.waitFor();
  await t.hover();
  if (await t.getByRole('button', { name: 'Pin message' }).count()) throw new Error('pin on a reply');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
