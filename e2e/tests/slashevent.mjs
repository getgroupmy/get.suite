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
const box = () => page.getByLabel('Message', { exact: true });
const dlg = () => page.getByRole('dialog', { name: 'New event' });
const chips = () => dlg().getByRole('list', { name: 'Invited guests' });
const chipsAre = async (want) => { let t = ''; try { await until(async () => (t = (await chips().textContent()).replace(/×/g, '').trim()) === want, 6000); } catch { throw new Error(JSON.stringify(t)); } };
const range = async () => (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 9 * 864e5}`)).body;
let kimId, priv, general;
await step('people and a private channel', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['bo', 'Bo Diaz']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
    if (local === 'kim') kimId = r.body.id;
  }
  priv = (await api(page, 'POST', '/chat/channels', { name: 'launch', private: true, members: [kimId] })).body.id;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
});
await step('/event in a private channel: Calendar opens it at that time with the people there; Save posts its card back', async () => {
  await page.goto(`${B}/chat/${priv}`);
  await box().fill('/event Planning tomorrow 3pm for 30m');
  await box().press('Enter');
  await page.waitForURL(/\/calendar/);
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Planning') throw new Error('title');
  await chipsAre('Kim Park');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await page.getByText('Posted in the conversation too').waitFor();
  const e = (await range()).find((x) => x.title === 'Planning');
  const s = new Date(e?.start);
  if (!e || s.getHours() !== 15 || e.end - e.start !== 30 * 60e3) throw new Error(JSON.stringify(e));
  const msgs = (await api(page, 'GET', `/chat/channels/${priv}/messages`)).body;
  if (!msgs.some((m) => m.body.startsWith('📅 Planning: ') && m.body.includes(`/calendar?event=${e.id}`))) throw new Error('no card');
});
await step('/event in an open channel invites only the people named with @', async () => {
  await page.goto(`${B}/chat/${general}`);
  await box().fill('/event Review with @bo friday 10am');
  await box().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Review with Bo') throw new Error('title');
  await chipsAre('Bo Diaz');
  await dlg().getByRole('button', { name: 'Cancel' }).click();
});
await step('/event alone in a private channel: the channel name, the people there, at a free time', async () => {
  await page.goto(`${B}/chat/${priv}`);
  await box().fill('/event');
  await box().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'launch') throw new Error('title');
  await chipsAre('Kim Park');
  await dlg().getByRole('button', { name: 'Cancel' }).click();
});
await step('a turned-off member is left out (📅 and /event), so Save works', async () => {
  await api(page, 'PATCH', `/users/${kimId}`, { disabled: true });
  const bo = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'bo@acme.com');
  await api(page, 'POST', `/chat/channels/${priv}/members`, { user_ids: [bo.id], user_id: bo.id });
  const mem = (await api(page, 'GET', `/chat/channels/${priv}/members`)).body;
  if (!mem.some((m) => m.username === 'bo@acme.com')) throw new Error(`bo not added: ${JSON.stringify(mem)}`);
  await page.goto(`${B}/chat/${priv}`);
  await box().fill('/event Sync tomorrow 9am');
  await box().press('Enter');
  await dlg().waitFor();
  await chipsAre('Bo Diaz');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  await page.goto(`${B}/chat/${priv}`);
  await page.getByRole('button', { name: 'Schedule a meeting with this conversation' }).click();
  await dlg().waitFor();
  await chipsAre('Bo Diaz'); // 📅 leaves the turned-off one out too
  await page.screenshot({ path: `${SP}/shots/slash-event.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
