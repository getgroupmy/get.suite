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
let kim;
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
let dm;
const threadsBtn = () => page.getByRole('button', { name: /^Threads/ });
const list = () => page.getByRole('list', { name: 'Your threads' });
await step('nothing yet', async () => {
  await page.goto(`${B}/chat`);
  await threadsBtn().click();
  await page.getByText('No threads yet').waitFor();
});
let p1, p2;
await step('replies to your message show in Threads with how many are new, live', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  p1 = (await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'plan for friday' })).body.id;
  p2 = (await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'lunch order' })).body.id;
  await api(page, 'POST', `/chat/channels/${dm}/read`);
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'pizza please', parent_id: p2 });
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'sounds good', parent_id: p1 });
  await threadsBtn().locator('.badge', { hasText: '2' }).waitFor();
  const items = list().locator('li');
  await items.first().getByText('plan for friday').waitFor();
  await items.nth(1).getByText('lunch order').waitFor();
  await items.first().getByText('Kim Park: sounds good').waitFor();
  await items.first().getByText('1 new').waitFor();
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'and dessert', parent_id: p2 });
  await until(async () => (await items.first().innerText()).includes('lunch order'));
  await items.first().getByText('2 new').waitFor();
  await items.first().getByText('2 replies').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-threads.png` });
});
await step('clicking one opens its thread; read, the counts go', async () => {
  await list().locator('li').first().getByRole('button').click();
  await page.waitForURL(new RegExp(`/chat/${dm}\\?msg=${p2}&thread=${p2}`));
  await page.locator('.thread-panel, aside').getByText('and dessert').first().waitFor();
  await until(async () => (await threadsBtn().locator('.badge').count()) === 0);
  await threadsBtn().click();
  await list().waitFor();
  if (await list().getByText(/\d+ new/).count()) throw new Error('still new');
  await list().getByText('You:').count();
});
await step('your own reply shows as yours and is not new', async () => {
  await page.goto(`${B}/chat/${dm}?msg=${p1}&thread=${p1}`);
  const box = page.getByPlaceholder(/Reply/);
  await box.fill('see you then');
  await box.press('Enter');
  await page.getByText('see you then').first().waitFor();
  await threadsBtn().click();
  await list().locator('li').first().getByText('You: see you then').waitFor();
  if (await threadsBtn().locator('.badge').count()) throw new Error('badge');
});
await step('Kim sees the threads she replied to', async () => {
  await kim.goto(`${B}/chat`);
  await kim.getByRole('button', { name: /^Threads/ }).click();
  const l = kim.getByRole('list', { name: 'Your threads' });
  await l.locator('li').first().getByText('Olivia Owner plan for friday').waitFor();
  await l.locator('li').first().getByText('1 new').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
