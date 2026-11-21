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

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let ch, kim;
const box = (p) => p.getByRole('textbox', { name: /^Message/ });
const run = async (p, text) => { await box(p).fill(text); await box(p).press('Enter'); };
await step('/invite @kim@acme.com in a private channel: Kim is added and told; the channel says so', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'plans', private: true })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat`);
  await kim.locator('aside.subnav').getByText('general', { exact: true }).waitFor();
  if (await kim.getByText('plans', { exact: true }).count()) throw new Error('Kim already sees it');
  await page.goto(`${B}/chat/${ch}`);
  await run(page, '/invite @kim@acme.com ');
  await page.getByText('Added Kim Park to #plans', { exact: true }).waitFor(); // the toast
  await page.locator('.msg', { hasText: '➕ Added Kim Park to #plans' }).waitFor();
  if (await box(page).inputValue()) throw new Error('the command stayed in the box');
  await kim.locator('aside.subnav').getByText('plans', { exact: true }).waitFor(); // live
  await kim.getByRole('button', { name: /Notifications/ }).first().click();
  await kim.getByText('Olivia Owner added you to #plans').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-invite.png` });
});
await step('/invite someone who isn’t a colleague: an error, and the text stays to fix', async () => {
  await run(page, '/invite @nobody@acme.com');
  await page.getByText('Not a colleague here: nobody@acme.com').waitFor();
  if (await box(page).inputValue() !== '/invite @nobody@acme.com') throw new Error('text lost');
  await box(page).fill('');
});
await step('/topic sets the topic, and the channel says so', async () => {
  await run(page, '/topic Launch on the 3rd');
  await page.locator('.msg', { hasText: '📝 Set the topic: Launch on the 3rd' }).waitFor();
  await page.getByText('Launch on the 3rd', { exact: true }).first().waitFor();
  if ((await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.id === ch).topic !== 'Launch on the 3rd') throw new Error('topic');
});
await step('/mute 2h mutes it until then; /mute off unmutes', async () => {
  await run(page, '/mute 2h');
  await page.getByText(/^Muted #plans until /).waitFor();
  const c = (await api(page, 'GET', '/chat/channels')).body.channels.find((x) => x.id === ch);
  if (!c.muted || Math.abs(c.muted_until - Date.now() - 2 * 36e5) > 60e3) throw new Error(JSON.stringify([c.muted, c.muted_until]));
  await run(page, '/mute off');
  await page.getByText('Unmuted #plans').waitFor();
  if ((await api(page, 'GET', '/chat/channels')).body.channels.find((x) => x.id === ch).muted) throw new Error('still muted');
});
await step('/leave in a thread works too; Kim leaves the private channel and it’s gone from her list', async () => {
  await kim.locator('aside.subnav').getByText('plans', { exact: true }).click();
  const msg = kim.locator('.msg', { hasText: 'Set the topic' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply in thread' }).click();
  const t = kim.getByRole('complementary', { name: 'Thread' });
  await t.getByRole('textbox', { name: 'Reply' }).fill('/leave');
  await t.getByRole('textbox', { name: 'Reply' }).press('Enter');
  await kim.getByText('You left #plans').waitFor();
  await until(async () => !kim.url().includes(ch)); // moved on from it
  await until(async () => !(await kim.locator('aside.subnav').getByText('plans', { exact: true }).count()));
  const members = (await api(page, 'GET', `/chat/channels/${ch}/members`)).body.map((u) => u.name);
  if (members.includes('Kim Park')) throw new Error(members.join());
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
