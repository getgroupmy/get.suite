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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
const openTask = (p, t) => p.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
let list, brief;
await step('attach a file from Drive and upload one; the row shows 📎 2', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Office' })).body.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Move office' });
  brief = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Moving brief' })).body;
  await page.goto(`${B}/tasks/${list}`);
  await openTask(page, 'Move office').locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('button', { name: 'From Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach to the task' });
  await pick.getByRole('button', { name: /Moving brief/ }).click();
  await d.getByRole('list', { name: 'Files' }).getByRole('link', { name: 'Moving brief' }).waitFor();
  await d.getByLabel('Upload files to the task').setInputFiles({ name: 'floorplan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 plan') });
  await d.getByRole('list', { name: 'Files' }).getByRole('link', { name: 'floorplan.pdf' }).waitFor();
  await openTask(page, 'Move office').getByText('📎 2').waitFor();
  const folders = (await api(page, 'GET', '/files')).body;
  if (!JSON.stringify(folders).includes('Task files')) throw new Error('no Task files folder');
});
await step('Kim, on the list, sees the files live and can open them', async () => {
  await kim.goto(`${B}/tasks/${list}`);
  await openTask(kim, 'Move office').getByText('📎 2').waitFor();
  await openTask(kim, 'Move office').locator('.task-main').click();
  const d = kim.getByRole('complementary', { name: 'Task details' });
  const link = d.getByRole('link', { name: 'Moving brief' });
  await link.waitFor();
  if ((await link.getAttribute('href')) !== `/docs/${brief.id}`) throw new Error(await link.getAttribute('href'));
  if ((await api(kim, 'GET', `/files/${brief.id}`)).status !== 200) throw new Error('Kim cannot open it');
  await d.getByRole('button', { name: 'Remove floorplan.pdf' }).click();
  await openTask(page, 'Move office').getByText('📎 1').waitFor();
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
