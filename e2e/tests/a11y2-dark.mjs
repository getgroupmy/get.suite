import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
const all = [];
const scan = async (name, p = page) => {
  await p.waitForTimeout(600);
  await p.addScriptTag({ content: AXE });
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
  for (const v of res) all.push({ page: name, ...v });
  if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
};
let form, ev, list;
await step('things to look at', async () => {
  const k = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const g = (await api(page, 'POST', '/groups', { name: 'Night shift' })).body;
  await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [k.body.id] });
  form = (await api(page, 'POST', '/forms', { title: 'Team lunch', questions: [{ id: 'q1', type: 'choice', title: 'Food?', options: ['Pizza', 'Sushi'], required: true }] })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', theme: { color: 'teal', background: 'tinted', font: 'formal' } });
  await api(page, 'POST', '/forms', { title: 'Old survey', questions: [{ id: 'a', type: 'short', title: 'Name' }] });
  const start = Date.now() + 864e5;
  ev = (await api(page, 'POST', '/events', { title: 'Budget review', start, end: start + 36e5, guests: ['kim@acme.com'] })).body;
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Party prep' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book venue', due: new Date().toISOString().slice(0, 10) });
  await api(page, 'POST', '/announcements', { text: 'Office closed Friday', group_id: g.id });
  await api(page, 'POST', '/announcements', { text: 'Maintenance', starts_at: Date.now() + 3 * 864e5 });
});
await step('a11y: form Theme window', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: '🎨 Theme' }).click();
  await page.getByRole('dialog', { name: 'Theme' }).waitFor();
  await scan('Theme window');
});
await step('a11y: Import questions window', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Import questions…' }).click();
  const d = page.getByRole('dialog', { name: 'Import questions' });
  await d.getByLabel('From the form').selectOption({ label: 'Old survey' });
  await d.getByRole('list', { name: 'Questions to import' }).waitFor();
  await scan('Import questions window');
});
await step('a11y: themed form page (signed out)', async () => {
  const ctx = await browser.newContext({ colorScheme: 'dark' }); const anon = await ctx.newPage();
  await anon.goto(`${B}/f/${form.token}`);
  await anon.getByRole('heading', { name: 'Team lunch' }).waitFor();
  try { await scan('Themed form page', anon); } finally { await ctx.close(); }
});
await step('a11y: Admin → Announcements (group and scheduled)', async () => {
  await page.goto(`${B}/admin?tab=announcements`);
  await page.getByRole('list', { name: 'Scheduled announcements' }).waitFor();
  await scan('Announcements admin');
});
await step('a11y: Admin → Reports chart, and its table', async () => {
  await page.goto(`${B}/admin?tab=reports`);
  const chart = page.getByRole('region', { name: 'Active people per day' });
  await chart.locator('svg').waitFor();
  await chart.locator('rect.hit').last().hover();
  await scan('Reports chart');
  await chart.getByRole('button', { name: 'Show as table' }).click();
  await scan('Reports table');
});
await step('a11y: event window', async () => {
  await page.goto(`${B}/calendar?event=${ev.id}`);
  await page.getByRole('dialog').first().waitFor();
  await scan('Event window');
});
await step('a11y: task details', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.locator('.task-main', { hasText: 'Book venue' }).click();
  await page.getByRole('complementary', { name: 'Task details' }).waitFor();
  await scan('Task details');
});
await step('a11y: a page with an announcement showing (Kim, in the group)', async () => {
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.getByRole('region', { name: 'Announcements' }).waitFor();
  await scan('Drive with announcement', kim);
});
for (const v of all) console.log(`DBG ${v.page} ${v.impact} ${v.id} x${v.n}: ${v.help} :: ${v.where} :: ${v.html}`);
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
