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
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
let list, ids = {};
const bar = (p, t) => p.getByRole('slider', { name: new RegExp(`^${t}:`) });
const get = async (id) => (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.find((x) => x.id === id);
await step('Timeline shows dated tasks as bars from start to due, and lists the rest', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  ids.design = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Design', due: day(4) })).body.id;
  await api(page, 'PATCH', `/tasks/tasks/${ids.design}`, { start: day(1) });
  ids.build = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Build', due: day(10) })).body.id;
  ids.party = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Party' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await bar(page, 'Design').waitFor();
  const w = async (t) => (await bar(page, t).boundingBox()).width;
  if (Math.round(await w('Design')) !== 4 * 32 || Math.round(await w('Build')) !== 32) throw new Error(`widths ${await w('Design')} ${await w('Build')}`);
  await page.locator('.tl-undated').getByRole('button', { name: 'Party' }).waitFor();
  await page.reload();
  await bar(page, 'Design').waitFor(); // the view is remembered
});
await step('the keyboard moves a bar a day, or changes its due date with Shift', async () => {
  await bar(page, 'Design').focus();
  await page.keyboard.press('ArrowRight');
  await until(async () => { const t = await get(ids.design); return t.start === day(2) && t.due === day(5); });
  await page.keyboard.press('Shift+ArrowRight');
  await until(async () => { const t = await get(ids.design); return t.start === day(2) && t.due === day(6); });
  await page.keyboard.press('Alt+ArrowLeft');
  await until(async () => { const t = await get(ids.design); return t.start === day(1) && t.due === day(6); });
});
await step('dragging a bar moves it; dragging its end stretches it; a colleague sees it live', async () => {
  await kim.goto(`${B}/tasks/${list}`);
  await kim.getByRole('tab', { name: 'Timeline' }).click();
  await bar(kim, 'Build').waitFor();
  const b = await bar(page, 'Build').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2 - 64, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await until(async () => (await get(ids.build)).due === day(8));
  const b2 = await bar(page, 'Build').boundingBox();
  await page.mouse.move(b2.x + b2.width - 2, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width - 2 + 96, b2.y + b2.height / 2, { steps: 6 });
  await page.mouse.up();
  await until(async () => { const t = await get(ids.build); return t.start === null && t.due === day(11); });
  await kim.getByRole('slider', { name: /^Build:/ }).and(kim.locator('[aria-valuetext]')).waitFor();
  await until(async () => Math.round((await bar(kim, 'Build').boundingBox()).x - b.x) === 3 * 32 || Math.round((await bar(kim, 'Build').boundingBox()).width) === 32);
});
await step('a click on a bar opens the task, where Starts sets the start', async () => {
  await bar(page, 'Build').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByLabel('Starts').fill(day(7));
  await until(async () => (await get(ids.build)).start === day(7));
  await until(async () => Math.round((await bar(page, 'Build').boundingBox()).width) === 5 * 32);
  await bar(kim, 'Build').waitFor();
  await until(async () => Math.round((await bar(kim, 'Build').boundingBox()).width) === 5 * 32);
  await page.screenshot({ path: `${SP}/shots/timeline.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
