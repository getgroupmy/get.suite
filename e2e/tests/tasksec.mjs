import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let list, t;
const inSec = (name) => page.getByRole('list', { name: `Tasks in ${name}`, exact: true }).locator('.task-title').allInnerTexts();
await step('add sections, put tasks in them, and drag one across', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Loose end' });
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Write post' });
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: '+ Add section' }).click();
  let dlg = page.getByRole('dialog', { name: 'New section' });
  await dlg.getByLabel('Section name').fill('This week');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('region', { name: 'Section This week' }).waitFor();
  await page.getByRole('button', { name: '+ Add section' }).click();
  dlg = page.getByRole('dialog', { name: 'New section' });
  await dlg.getByLabel('Section name').fill('Later');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('region', { name: 'Section Later' }).waitFor();
  // Put "Write post" in This week from its details.
  await task(page, 'Write post').locator('.task-main').click();
  const details = page.getByRole('complementary', { name: 'Task details' });
  await details.getByLabel('Section').selectOption({ label: 'This week' });
  await until(async () => (await inSec('This week')).join('|') === 'Write post');
  // Add a task straight into Later.
  await page.getByRole('button', { name: 'Section actions: Later' }).click();
  await page.getByRole('menuitem', { name: 'Add a task here…' }).click();
  dlg = page.getByRole('dialog', { name: 'Add a task to Later' });
  await dlg.getByLabel('Task').fill('Party');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await until(async () => (await inSec('Later')).join('|') === 'Party');
  // Drag "Loose end" onto Party: it joins Later.
  await task(page, 'Loose end').dragTo(task(page, 'Party'), { targetPosition: { x: 40, y: 4 } });
  await until(async () => (await inSec('Later')).join('|') === 'Loose end|Party');
  await page.screenshot({ path: `${SP}/shots/task-sections.png` });
  const all = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
  const later = (await api(page, 'GET', `/tasks/lists/${list}/sections`)).body.find((x) => x.name === 'Later');
  if (all.find((x) => x.title === 'Loose end').section_id !== later.id) throw new Error('not saved');
});
await step('move, rename and delete a section (its tasks stay)', async () => {
  await page.getByRole('button', { name: 'Section actions: Later' }).click();
  await page.getByRole('menuitem', { name: 'Move section up' }).click();
  await until(async () => (await page.locator('.task-section h3').allInnerTexts()).map((x) => x.split(' ')[1]).join('|') === 'Later|This');
  await page.getByRole('button', { name: 'Section actions: This week' }).click();
  await page.getByRole('menuitem', { name: 'Rename section…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename section' });
  await dlg.getByLabel('Section name').fill('Now');
  await dlg.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('region', { name: 'Section Now' }).waitFor();
  await page.getByRole('button', { name: 'Section actions: Later' }).click();
  await page.getByRole('menuitem', { name: 'Delete section…' }).click();
  await page.getByRole('button', { name: 'Delete section, keep tasks' }).click();
  await until(async () => !(await page.getByRole('region', { name: 'Section Later' }).count()));
  const loose = await page.getByRole('list', { name: 'Tasks', exact: true }).locator('.task-title').allInnerTexts();
  if (loose.sort().join('|') !== 'Loose end|Party') throw new Error(loose.join('|'));
});
await step('fold a section away: its tasks hide, and it stays folded after a reload', async () => {
  const toggle = page.getByRole('region', { name: 'Section Now' }).locator('.task-section-fold');
  await toggle.click();
  await until(async () => (await toggle.getAttribute('aria-expanded')) === 'false');
  if (await page.getByRole('list', { name: 'Tasks in Now', exact: true }).count()) throw new Error('still shown');
  await page.reload();
  const t2 = page.getByRole('region', { name: 'Section Now' }).locator('.task-section-fold');
  await until(async () => (await t2.getAttribute('aria-expanded')) === 'false');
  await t2.click();
  await page.getByRole('list', { name: 'Tasks in Now', exact: true }).waitFor();
});
await step('put several selected tasks in a section at once', async () => {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const t of ['Loose end', 'Party']) await page.getByRole('checkbox', { name: `Select: ${t}` }).check();
  await page.getByRole('toolbar', { name: 'Change the selected tasks' }).getByLabel('Put the selected tasks in a section').selectOption({ label: 'Now' });
  await page.getByText('2 tasks put in Now').waitFor();
  await until(async () => (await page.getByRole('list', { name: 'Tasks in Now', exact: true }).locator('.task-title').allInnerTexts()).sort().join('|') === 'Loose end|Party|Write post');
});
await step('Download as CSV says which section each task is in', async () => {
  await page.getByRole('button', { name: 'Done selecting' }).click().catch(() => {});
  await page.getByRole('button', { name: 'List actions' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as CSV' }).click()]);
  const fs = await import('node:fs');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  if (!/^\ufeff?Task,Section,Status/.test(text) || !/Party,Now,/.test(text)) throw new Error(text.slice(0, 200));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
