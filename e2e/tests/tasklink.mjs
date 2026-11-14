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
let general, list, lee;
await step('copy a link to a task, paste it in Chat', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch plan' })).body.id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  const t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book the venue', due: '2020-01-06', assignee_id: kimId })).body;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.goto(`${B}/tasks/${list}?task=${t.id}`);
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Copy link to task' }).click();
  await page.getByText('Link to the task copied').waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (url !== `${B}/tasks/${list}?task=${t.id}`) throw new Error(`copied ${url}`);
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Message', { exact: true }).fill(`Who has this? ${url}`);
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const card = page.getByRole('link', { name: 'Task: Book the venue (To do)' });
  await card.waitFor();
  const txt = await card.textContent();
  if (!/Launch plan/.test(txt) || !/for Kim Park/.test(txt) || !/Due/.test(txt)) throw new Error(txt);
  await page.locator('.task-card-late').waitFor();
  await page.screenshot({ path: `${SP}/shots/tasklink-card.png` });
  await card.click();
  await until(() => page.url().includes(`/tasks/${list}?task=${t.id}`));
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('textbox', { name: 'Task' }).waitFor();
  if (await page.getByRole('complementary', { name: 'Task details' }).getByRole('textbox', { name: 'Task' }).inputValue() !== 'Book the venue') throw new Error('wrong task open');
  // Ticked off: the card says so (for someone loading it afresh).
  await api(page, 'PATCH', `/tasks/tasks/${t.id}`, { done: true });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByRole('link', { name: 'Task: Book the venue (Done)' }).waitFor();
});
await step('someone not on the list sees only that there is a task', async () => {
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/chat/${general}`);
  await lee.getByText('A task you can’t see').waitFor();
  if (await lee.getByText('Book the venue').count()) throw new Error('Lee must not see it');
  await lee.screenshot({ path: `${SP}/shots/tasklink-lee.png` });
});
await step('tick it off (and back) on its card', async () => {
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByRole('button', { name: 'Mark not done: Book the venue' }).click();
  await kim.getByText('Not done yet: Book the venue').waitFor();
  await kim.getByRole('link', { name: 'Task: Book the venue (To do)' }).waitFor();
  await kim.getByRole('button', { name: 'Mark done: Book the venue' }).click();
  await kim.getByRole('link', { name: 'Task: Book the venue (Done)' }).waitFor();
  const t = (await api(kim, 'GET', '/tasks/search?q=venue')).body[0];
  if (!t.done) throw new Error('not saved');
  if (await lee.getByRole('button', { name: /Mark (not )?done/ }).count()) throw new Error('Lee gets a button');
});
await step('the task card keeps up: Kim marks it not done, Olivia’s open card follows', async () => {
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('link', { name: 'Task: Book the venue (Done)' }).waitFor();
  await kim.getByRole('button', { name: 'Mark not done: Book the venue' }).click();
  await page.getByRole('link', { name: 'Task: Book the venue (To do)' }).waitFor({ timeout: 10000 });
});
await step('one task: Send in Chat from its details puts its link in #general', async () => {
  const t = (await api(page, 'GET', '/tasks/search?q=venue')).body[0];
  await page.goto(`${B}/tasks/${t.list_id}?task=${t.id}`);
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Send in Chat' }).click();
  const d = page.getByRole('dialog', { name: 'Send the task in Chat' });
  await d.getByLabel('Conversation').selectOption({ label: '# general' });
  await d.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(`**/chat/${general}`);
  await until(async () => (await page.getByLabel('Message', { exact: true }).inputValue()).includes(`task=${t.id}`));
});
await step('⋮ → Chat with the list’s people: the list’s own channel, Kim in it', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Chat with the list’s people' }).click();
  await page.waitForURL(/\/chat\/[\w-]+$/);
  const chanId = page.url().split('/chat/')[1];
  await page.getByText('A channel for this list, with everyone on it').waitFor();
  await page.getByText(/For the task list /).first().waitFor();
  const kc = (await api(kim, 'GET', '/chat/channels')).body.channels.find((c) => c.id === chanId);
  if (!kc || !kc.private) throw new Error('Kim not in a private channel');
});
await step('its channel says what it’s about at the top', async () => {
  await page.getByText('· this channel’s task list').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
