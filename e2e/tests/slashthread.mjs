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
const pad = (n) => String(n).padStart(2, '0');
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
let general, top;
const panel = () => page.getByRole('complementary', { name: 'Thread' });
const reply = () => panel().getByLabel('Reply', { exact: true });
await step('the reply box lists the commands; Escape closes the list, not the thread', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  top = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Planning the offsite' })).body;
  await page.goto(`${B}/chat/${general}`);
  const m = page.locator(`[data-mid="${top.id}"]`);
  await m.hover();
  await m.getByRole('button', { name: 'Reply in thread' }).click();
  await reply().fill('/');
  const list = panel().getByRole('listbox', { name: 'Commands' });
  if ((await list.getByRole('option').count()) !== 6) throw new Error("no list");
  await reply().press('ArrowDown');
  await reply().press('Enter');
  if (await reply().inputValue() !== '/poll ') throw new Error(await reply().inputValue());
  await reply().fill('/');
  await reply().press('Escape');
  if (await list.count()) throw new Error('list not closed');
  if (!(await panel().count())) throw new Error('thread closed');
  await reply().press('Escape');
  await panel().waitFor({ state: 'detached' });
});
const openThread = async () => {
  const m = page.locator(`[data-mid="${top.id}"]`);
  await m.hover();
  await m.getByRole('button', { name: 'Reply in thread' }).click();
  await reply().waitFor();
};
await step('/poll in a thread: a poll reply there, not in the conversation', async () => {
  await openThread();
  await reply().fill('/poll Where? | Lake | City');
  await reply().press('Enter');
  await panel().getByText('Where?').waitFor();
  await panel().getByText('Lake').waitFor();
  if (await reply().inputValue() !== '') throw new Error('not cleared');
  if (await page.locator('.messages').getByText('Where?').count()) throw new Error('in the main list');
  await page.locator(`[data-mid="${top.id}"]`).getByText(/1 reply/).waitFor();
});
await step('/meet in a thread: the meeting link is a reply', async () => {
  await reply().fill('/meet');
  const [tab] = await Promise.all([page.context().waitForEvent('page'), reply().press('Enter')]);
  await tab.waitForURL(/\/meet\//);
  await tab.close();
  await panel().getByText(/Started a video meeting/).waitFor();
});
await step('/task in a thread: a task whose link opens this thread', async () => {
  await reply().fill('/task Book the lake house');
  await reply().press('Enter');
  await page.getByText(/^Added to /).first().waitFor();
  const { lists } = (await api(page, 'GET', '/tasks/lists')).body;
  const tasks = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const t = (tasks.tasks || tasks).find((x) => x.title === 'Book the lake house');
  const url = t?.link_url;
  if (url !== `/chat/${general}?msg=${top.id}&thread=${top.id}`) throw new Error(JSON.stringify(t));
  await page.goto(`${B}${url}`);
  await panel().getByText('Where?').waitFor();
});
await step('a bad command in a thread: an error, the text stays', async () => {
  await reply().fill('/poll Where?');
  await reply().press('Enter');
  await page.getByText('Write it as /poll Question | option | option').waitFor();
  if (await reply().inputValue() !== '/poll Where?') throw new Error(await reply().inputValue());
  await page.screenshot({ path: `${SP}/shots/slash-thread.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
