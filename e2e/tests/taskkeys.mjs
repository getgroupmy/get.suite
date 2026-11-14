import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let list;
const focused = () => page.evaluate(() => document.activeElement?.closest?.('li.task')?.querySelector('.task-title')?.textContent || document.activeElement?.getAttribute('aria-label') || '');
const tasksNow = async () => (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
await step('J / K move between the tasks, with the focus', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Errands' })).body.id;
  for (const t of ['Post the parcel', 'Buy stamps', 'Call the bank']) await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: t });
  await page.goto(`${B}/tasks/${list}`);
  await page.locator('li.task').nth(2).waitFor();
  await page.locator('h1').first().click(); // nothing focused
  await page.keyboard.press('j');
  await until(async () => (await focused()) === 'Call the bank');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await until(async () => (await focused()) === 'Post the parcel');
  await page.keyboard.press('j'); // the last stays
  await page.keyboard.press('k');
  await until(async () => (await focused()) === 'Buy stamps');
  await page.screenshot({ path: `${SP}/shots/task-keys.png` });
});
await step('S stars it; X ticks it off and the focus goes on to the next', async () => {
  await page.keyboard.press('s');
  await until(async () => (await tasksNow()).find((t) => t.title === 'Buy stamps').important);
  await page.keyboard.press('x');
  await until(async () => (await tasksNow()).find((t) => t.title === 'Buy stamps').done);
  await until(async () => (await focused()) === 'Post the parcel');
});
await step('Enter opens it; # deletes one (with Undo)', async () => {
  await page.keyboard.press('Enter');
  await page.getByRole('complementary', { name: 'Task details' }).waitFor();
  if (!/task=/.test(page.url())) throw new Error(page.url());
  await page.locator('li.task', { hasText: 'Call the bank' }).locator('.task-main').focus();
  await page.keyboard.press('Shift+#');
  await page.locator('.toast', { hasText: 'Task deleted' }).waitFor();
  await until(async () => !(await tasksNow()).some((t) => t.title === 'Call the bank'));
});
await step('N goes to Add a task, where letters are typed, not shortcuts', async () => {
  await page.locator('h1').first().click();
  await page.keyboard.press('n');
  await until(async () => (await focused()) === 'Add a task');
  await page.keyboard.type('jks');
  if ((await page.getByLabel('Add a task').inputValue()) !== 'jks') throw new Error('typed keys were taken');
  await page.getByLabel('Add a task').fill('');
});
await step('the shortcut list shows Tasks first; turned off, J does nothing', async () => {
  await page.locator('h1').first().click();
  await page.keyboard.press('Control+/');
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Next or previous task').waitFor();
  const first = await dlg.locator('h3, h2').allInnerTexts();
  if (!first.some((x) => /Tasks/.test(x))) throw new Error(first.join(' | '));
  await axe(page, 'shortcut list');
  await page.keyboard.press('Escape');
  await api(page, 'PUT', '/users/me/keys', { on: false });
  await page.reload();
  await page.locator('li.task').first().waitFor();
  await page.locator('h1').first().click();
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  if (await focused() === 'Post the parcel') throw new Error('J still works');
  await api(page, 'PUT', '/users/me/keys', { on: true });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
