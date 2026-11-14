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
let list, tid, kim;
await step('setup: a shared list; Kim changes a task', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  tid = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book venue' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await api(kim, 'PATCH', `/tasks/tasks/${tid}`, { assignee_id: kimId, due: '2026-12-03' });
  await api(kim, 'PATCH', `/tasks/tasks/${tid}`, { due: '2026-12-04', tags: ['venue'] });
});
const details = () => page.getByRole('complementary', { name: 'Task details' });
const history = () => details().getByRole('list', { name: 'History' });
await step('History in the details: who did what, newest first, and who added it', async () => {
  await page.goto(`${B}/tasks/${list}?task=${tid}`);
  await details().getByText('History', { exact: true }).click();
  await until(async () => (await history().locator('li').count()) === 4);
  const lines = (await history().locator('li').allInnerTexts()).map((s) => s.split(' · ')[0].trim());
  if (!/^Kim Park added #venue\|Kim Park set the due date to (4 Dec|Dec 4)\|Kim Park took it on\|You added it$/.test(lines.join('|'))) throw new Error(lines.join('|'));
  await page.screenshot({ path: `${SP}/shots/task-history.png` });
  await axe(page, 'history');
});
await step('a change made here shows straight away; one by someone else as it happens', async () => {
  await details().getByLabel('Priority').selectOption('high');
  await until(async () => /^You set the priority to High/.test(await history().locator('li').first().innerText()));
  await api(kim, 'PATCH', `/tasks/tasks/${tid}`, { done: true });
  await until(async () => /^Kim Park ticked it off/.test(await history().locator('li').first().innerText()));
});
await step('steps added in the details show as one line', async () => {
  await page.goto(`${B}/tasks/${list}?task=${tid}`);
  await details().getByText('History', { exact: true }).click();
  for (const title of ['Call the venue', 'Pay the deposit']) {
    await details().getByPlaceholder('Add a step').fill(title);
    await details().getByPlaceholder('Add a step').press('Enter');
  }
  await until(async () => (await history().locator('li').first().innerText()).startsWith('You added the steps “Call the venue”, “Pay the deposit”'));
  await axe(page, 'history with steps');
});
await step('the list’s Activity: what happened to every task, newest first; a task opens from it', async () => {
  const gone = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Order cake' })).body.id;
  await api(kim, 'DELETE', `/tasks/tasks/${gone}`);
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Activity…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Activity · Launch' });
  const items = dlg.getByRole('list', { name: 'Activity' }).locator(':scope > li');
  await until(async () => (await items.count()) >= 6);
  const first = (await items.first().innerText()).replace(/\s+/g, ' ');
  if (!/Kim Park deleted it · .*Order cake \(deleted\)/.test(first)) throw new Error(first);
  const all = (await items.allInnerTexts()).join(' | ');
  for (const want of ['You added it', 'Kim Park ticked it off', 'You set the priority to High', 'Kim Park took it on']) if (!all.includes(want)) throw new Error(`${want} missing: ${all.slice(0, 400)}`);
  await page.screenshot({ path: `${SP}/shots/list-activity.png` });
  await axe(page, 'activity');
  await dlg.getByRole('button', { name: 'Book venue' }).first().click();
  await details().waitFor();
  if (!page.url().includes(`task=${tid}`)) throw new Error(page.url());
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
