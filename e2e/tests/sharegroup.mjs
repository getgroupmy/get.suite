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
let kim, kimId;
await step('Kim, watching her bell', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.getByRole('button', { name: /^Notifications/ }).click();
});
await step('three files shared with her: one entry counting them, opening Shared with me', async () => {
  const panel = kim.getByRole('dialog', { name: 'Notifications' });
  for (const name of ['Q1 report', 'Q2 report', 'Q3 report']) {
    const f = (await api(page, 'POST', '/files/new', { kind: 'doc', name })).body;
    await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
    if (name === 'Q1 report') await panel.getByText('Olivia Owner shared “Q1 report” with you').waitFor();
  }
  await panel.getByText('Olivia Owner shared 3 files with you').waitFor();
  await panel.getByText('The latest “Q3 report”').waitFor();
  await kim.getByRole('button', { name: 'Notifications, 1 new' }).waitFor();
  // Opened up: each file, the latest first, each opening itself.
  await panel.getByRole('button', { name: 'Show all 3' }).click();
  const inside = panel.getByRole('list', { name: 'In “Olivia Owner shared 3 files with you”' });
  const labels = await inside.getByRole('button').allInnerTexts();
  if (labels.join('|') !== 'Q3 report|Q2 report|Q1 report') throw new Error(labels.join('|'));
  await kim.screenshot({ path: `${SP}/shots/shares-grouped-open.png` });
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  for (const scheme of ['light', 'dark']) {
    await kim.emulateMedia({ colorScheme: scheme });
    await kim.addScriptTag({ content: AXE });
    const r = await kim.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${scheme}: ${r.join(' | ')}`);
  }
  await kim.emulateMedia({ colorScheme: 'light' });
  await inside.getByRole('button', { name: 'Q1 report' }).click();
  await kim.waitForURL(/\/docs\//);
  await kim.goBack();
  await kim.getByRole('button', { name: /^Notifications/ }).click();
  await panel.getByText('Olivia Owner shared 3 files with you').click();
  await kim.waitForURL(/\/drive\/shared$/);
  for (const name of ['Q1 report', 'Q2 report', 'Q3 report']) await kim.getByText(name).first().waitFor();
  await kim.screenshot({ path: `${SP}/shots/shares-grouped.png` });
});
await step('two tasks given on one list: grouped; opened up, one opens that task', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  const t1 = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book venue', assignee_id: kimId })).body;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Order cake', assignee_id: kimId });
  await kim.goto(`${B}/drive`);
  await kim.getByRole('button', { name: /^Notifications/ }).click();
  const panel = kim.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Olivia Owner gave you 2 tasks').waitFor();
  await panel.getByRole('button', { name: 'Show all 2' }).click();
  const inside = panel.getByRole('list', { name: 'In “Olivia Owner gave you 2 tasks”' });
  if ((await inside.getByRole('button').allInnerTexts()).join('|') !== 'Order cake|Book venue') throw new Error('order');
  await inside.getByRole('button', { name: 'Book venue' }).click();
  await kim.waitForURL(new RegExp(`/tasks/${list}\\?task=${t1.id}`));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
