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
let listId, taskId;
await step('comment on a task on a shared list', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  listId = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'PUT', `/tasks/lists/${listId}/members`, { user_ids: [kimId] });
  taskId = (await api(page, 'POST', `/tasks/lists/${listId}/tasks`, { title: 'Book venue', assignee_id: kimId })).body.id;
  await page.goto(`${B}/tasks/${listId}?task=${taskId}`);
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Add a comment').fill('Hotel or hall?');
  await d.getByRole('button', { name: 'Post' }).click();
  await d.getByRole('list', { name: 'Comments' }).getByText('Hotel or hall?').waitFor();
  await page.locator('.task', { hasText: 'Book venue' }).getByText('💬 1').waitFor();
});
await step('the colleague is told, sees it and answers; it shows live', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/tasks/${listId}?task=${taskId}`);
  const d = kim.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('list', { name: 'Comments' }).getByText('Hotel or hall?').waitFor();
  await d.getByLabel('Add a comment').fill('Hall, it is cheaper');
  await d.getByRole('button', { name: 'Post' }).click();
  await page.getByRole('complementary', { name: 'Task details' }).getByText('Hall, it is cheaper').waitFor();
  await page.locator('.task', { hasText: 'Book venue' }).getByText('💬 2').waitFor();
  const bell = (await api(kim, 'GET', '/notifications')).body;
  if (!JSON.stringify(bell).includes('Olivia Owner commented on “Book venue”')) throw new Error('not told');
}, kim);
await step('edit your own comment: Escape keeps it and the details open; Save changes it, (edited), live for the colleague', async () => {
  const d = page.getByRole('complementary', { name: 'Task details' });
  const mine = d.getByRole('list', { name: 'Comments' }).getByRole('listitem').filter({ hasText: 'Hotel or hall?' });
  if (await d.getByRole('list', { name: 'Comments' }).getByRole('listitem').filter({ hasText: 'Hall, it is cheaper' }).getByRole('button', { name: 'Edit comment' }).count()) throw new Error('can edit someone else’s');
  await mine.getByRole('button', { name: 'Edit comment' }).click();
  const input = d.getByLabel('Change your comment');
  await input.fill('Nope');
  await input.press('Escape');
  await d.getByText('Hotel or hall?').waitFor();
  if (!(await d.isVisible())) throw new Error('Escape closed the details');
  await mine.getByRole('button', { name: 'Edit comment' }).click();
  await input.fill('Hotel, or the town hall?');
  await input.locator('xpath=..').getByRole('button', { name: 'Save' }).click();
  await d.getByText('Hotel, or the town hall?').waitFor();
  await d.getByRole('list', { name: 'Comments' }).getByText(/\(edited\)/).waitFor();
  await kim.getByRole('complementary', { name: 'Task details' }).getByText('Hotel, or the town hall?').waitFor({ timeout: 10000 });
});
await step('Print in the details: the task with its comments, (edited) marked', async () => {
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('button', { name: 'Print', exact: true }).click();
  const frame = page.frameLocator('iframe.print-frame').last();
  await frame.getByRole('heading', { name: 'Book venue' }).waitFor({ state: 'attached' });
  const text = await page.locator('iframe.print-frame').last().evaluate((f) => f.contentDocument.body.innerText);
  if (!/Launch/.test(text) || !/COMMENTS|Comments/.test(text)) throw new Error(text);
  if (!/Olivia Owner .*\(edited\)\s*Hotel, or the town hall\?/s.test(text)) throw new Error(text);
  if (!/Kim Park .*\s*Hall, it is cheaper/s.test(text)) throw new Error(text);
});
await step('searching finds a task by its comment, in Tasks and in the top bar, saying which comment', async () => {
  await page.getByLabel('Search tasks').fill('cheaper');
  await page.getByLabel('Search tasks').press('Enter');
  await page.getByRole('heading', { name: 'Tasks matching “cheaper”' }).waitFor();
  await page.locator('.task', { hasText: 'Book venue' }).getByText('Comment: “Hall, it is cheaper”').waitFor();
  await page.getByRole('button', { name: 'Close search' }).click();
  await page.getByLabel('Search everything').fill('cheaper');
  const res = page.getByRole('listbox', { name: 'Search results' });
  await res.getByText(/💬 “Hall, it is cheaper” · Launch/).waitFor();
});
await step('a colleague’s comment is new on the task’s row (live) until you open the task', async () => {
  await page.goto(`${B}/tasks/${listId}`);
  const row = page.locator('.task', { hasText: 'Book venue' });
  await row.getByText(/💬 \d/).waitFor();
  if (await row.locator('.task-comments-new').count()) throw new Error('new before anything new');
  await api(kim, 'POST', `/tasks/tasks/${taskId}/comments`, { body: 'Hall is booked' });
  await row.locator('.task-comments-new', { hasText: '1 new' }).waitFor({ timeout: 10000 });
  await row.locator('.task-main').click();
  await page.getByRole('complementary', { name: 'Task details' }).getByText('Hall is booked').waitFor();
  await until(async () => !(await row.locator('.task-comments-new').count()));
});
await step('Assigned to me shows it as new too', async () => {
  await kim.goto(`${B}/tasks/assigned`); // (not with the task open, where it would be read at once)
  const row = kim.locator('.task', { hasText: 'Book venue' });
  await row.waitFor();
  await api(page, 'POST', `/tasks/tasks/${taskId}/comments`, { body: 'Deposit paid' });
  await kim.reload();
  await row.locator('.task-comments-new', { hasText: '1 new' }).waitFor({ timeout: 10000 });
}, kim);
await step('Home: Tasks for today says a task has new comments', async () => {
  const today = await kim.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const r = await api(page, 'PATCH', `/tasks/tasks/${taskId}`, { due: today });
  if (r.status !== 200) throw new Error(`due ${r.status}`);
  await kim.goto(`${B}/home`);
  const card = kim.getByRole('region', { name: 'Tasks for today' });
  await card.getByRole('listitem').filter({ hasText: 'Book venue' }).getByText('💬 1 new').waitFor();
}, kim);
await step('Board: a card says how many comments are new, until it is opened', async () => {
  await page.goto(`${B}/tasks/${listId}`);
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  const card = page.locator('.board-card', { hasText: 'Book venue' });
  await card.waitFor();
  await api(kim, 'POST', `/tasks/tasks/${taskId}/comments`, { body: 'Caterer confirmed' });
  await card.locator('.task-comments-new', { hasText: '1 new' }).waitFor({ timeout: 10000 });
  await card.locator('.board-open').click();
  await page.getByRole('complementary', { name: 'Task details' }).getByText('Caterer confirmed').waitFor();
  await until(async () => !(await card.locator('.task-comments-new').count()));
  await page.getByRole('tab', { name: 'List', exact: true }).click();
});
await step('the sidebar marks a list with new comments (💬), until the task is opened', async () => {
  await page.goto(`${B}/tasks/${listId}`);
  const mark = page.getByRole('img', { name: '1 task with new comments' });
  await page.locator('.task', { hasText: 'Book venue' }).waitFor();
  if (await mark.count()) throw new Error('marked before anything new');
  await api(kim, 'POST', `/tasks/tasks/${taskId}/comments`, { body: 'Menu agreed' });
  await mark.waitFor({ timeout: 10000 });
  await page.locator('.task', { hasText: 'Book venue' }).locator('.task-main').click();
  await page.getByRole('complementary', { name: 'Task details' }).getByText('Menu agreed').waitFor();
  await until(async () => !(await mark.count()));
});
await step('@ in a comment suggests people; picking one mentions them, and they are told so', async () => {
  await page.goto(`${B}/tasks/${listId}?task=${taskId}`);
  const d = page.getByRole('complementary', { name: 'Task details' });
  const input = d.getByLabel('Add a comment');
  await input.click();
  await input.pressSequentially('Please confirm @kim');
  const pick = page.getByRole('listbox', { name: 'People to mention' });
  await pick.getByRole('option', { name: /Kim Park/ }).waitFor();
  await input.press('Enter'); // picks, doesn't post
  if ((await input.inputValue()) !== 'Please confirm @kim@acme.com ') throw new Error(await input.inputValue());
  await input.pressSequentially('by Friday');
  await d.getByRole('button', { name: 'Post' }).click();
  await d.getByRole('list', { name: 'Comments' }).locator('.mention', { hasText: '@kim@acme.com' }).waitFor();
  await until(async () => JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('Olivia Owner mentioned you on “Book venue”'));
});
await step('mentioning someone who isn’t on the list says they won’t be told', async () => {
  const d = page.getByRole('complementary', { name: 'Task details' });
  const input = d.getByLabel('Add a comment');
  await input.fill('Ask @zed@acme.com too');
  await d.getByRole('status').filter({ hasText: "@zed@acme.com isn't on this list, so won't be told" }).waitFor();
  await input.fill('Ask @kim@acme.com and @olivia@acme.com');
  await until(async () => !(await d.getByText(/on this list, so won.t be told/).count()));
  await input.fill('');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
