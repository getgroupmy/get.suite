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
let pub, priv, general, lee;
await step('copy a link to a message', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  pub = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  priv = (await api(page, 'POST', '/chat/channels', { name: 'board', private: true, members: [kimId] })).body.id;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await api(page, 'POST', `/chat/channels/${pub}/messages`, { body: 'Launch moves to *Friday* at 10' });
  await api(page, 'POST', `/chat/channels/${priv}/messages`, { body: 'Budget is 40k' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.goto(`${B}/chat/${pub}`);
  const msg = page.locator('.msg', { hasText: 'Launch moves' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Copy link to message' }).click();
  await page.getByText('Link to the message copied').waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (!new RegExp(`/chat/${pub}\\?msg=`).test(url)) throw new Error(`copied ${url}`);
  // Pasted in #general: a quoted card.
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Message', { exact: true }).fill(`See ${url}`);
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const card = page.getByRole('link', { name: 'Message from Olivia Owner in #launch' });
  await card.waitFor();
  if (!(await card.textContent()).includes('Launch moves to *Friday* at 10')) throw new Error(await card.textContent());
  await page.screenshot({ path: `${SP}/shots/msglink-card.png` });
  // Clicking it goes to the message.
  await card.click();
  await until(() => page.url().includes(`/chat/${pub}?msg=`));
  await page.locator('.msg', { hasText: 'Launch moves' }).waitFor();
});
await step('a private message: shown to members, not to others', async () => {
  const m = (await api(page, 'GET', `/chat/channels/${priv}/messages`)).body.find((x) => x.body === 'Budget is 40k');
  await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Re ${B}/chat/${priv}?msg=${m.id}` });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${general}`);
  const kc = kim.getByRole('link', { name: 'Message from Olivia Owner in a private channel' });
  await kc.waitFor();
  if (!(await kc.textContent()).includes('Budget is 40k')) throw new Error('Kim should see it');
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/chat/${general}`);
  await lee.getByText('A message you can’t see').waitFor();
  if (await lee.getByText('Budget is 40k').count()) throw new Error('Lee must not see it');
  await lee.getByRole('link', { name: 'Message from Olivia Owner in #launch' }).waitFor();
  await lee.screenshot({ path: `${SP}/shots/msglink-lee.png` });
});
await step('a message → Create event: a new event from it, with a link back that opens the message', async () => {
  const m = (await api(page, 'POST', `/chat/channels/${pub}/messages`, { body: '**Demo** for Globex\nThursday works for them' })).body;
  await page.goto(`${B}/chat/${pub}`);
  const msg = page.locator('.msg', { hasText: 'Thursday works for them' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/calendar/);
  const dlg = page.getByRole('dialog', { name: 'New event' });
  if ((await dlg.getByLabel('Title').inputValue()) !== 'Demo for Globex') throw new Error(await dlg.getByLabel('Title').inputValue());
  const text = await dlg.getByLabel('Description').inputValue();
  if (!new RegExp(`^\\*\\*Demo\\*\\* for Globex\\nThursday works for them\\n\\nFrom Olivia Owner in Chat: https?://[^/\\s]+/chat/${pub}\\?msg=${m.id}$`).test(text)) throw new Error(text);
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  const now = Date.now();
  const evs = (await api(page, 'GET', `/events?from=${now - 36e5}&to=${now + 2 * 864e5}`)).body;
  const ev = (Array.isArray(evs) ? evs : evs.events || []).find((e) => e.title === 'Demo for Globex');
  if (!ev || ev.end - ev.start !== 36e5 || ev.start < now) throw new Error(JSON.stringify(ev));
  await page.goto(text.split(': ').pop().replace(/^https?:\/\/[^/]+/, B));
  await page.locator('.msg', { hasText: 'Thursday works for them' }).waitFor();
});
await step('a message naming a day and time → Create event: the event is then', async () => {
  await api(page, 'POST', `/chat/channels/${pub}/messages`, { body: 'Walkthrough with Initech tomorrow 3pm' });
  await page.goto(`${B}/chat/${pub}`);
  const msg = page.locator('.msg', { hasText: 'Walkthrough with Initech' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/calendar/);
  const dlg = page.getByRole('dialog', { name: 'New event' });
  if ((await dlg.getByLabel('Title').inputValue()) !== 'Walkthrough with Initech') throw new Error(await dlg.getByLabel('Title').inputValue());
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  const now = Date.now();
  const evs = (await api(page, 'GET', `/events?from=${now - 36e5}&to=${now + 3 * 864e5}`)).body;
  const ev = (Array.isArray(evs) ? evs : evs.events || []).find((e) => e.title === 'Walkthrough with Initech');
  const want = new Date(); want.setDate(want.getDate() + 1); want.setHours(15, 0, 0, 0);
  if (!ev || ev.start !== want.getTime() || ev.end - ev.start !== 36e5) throw new Error(JSON.stringify(ev && [new Date(ev.start).toString(), ev.end - ev.start]));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
