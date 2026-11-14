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
const box = () => page.getByLabel('Search everything');
const results = () => page.getByRole('listbox', { name: 'Search results' });
await step('things to find in every app', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Zephyr', password: 'password123' });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Zephyr launch plan' });
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book Zephyr venue' });
  await api(page, 'POST', '/notes', { title: 'Zephyr ideas', body: 'Kites' });
  const t = Date.now() + 864e5;
  await api(page, 'POST', '/events', { title: 'Zephyr review', start: t, end: t + 36e5 });
  await api(page, 'POST', '/contacts', { name: 'Zed Zephyrson', email: 'zed@example.com' });
  const ch = (await api(page, 'GET', '/chat/channels')).body.channels[0];
  await api(page, 'POST', `/chat/channels/${ch.id}/messages`, { body: 'Who is coming to the zephyr kickoff?', files: [] });
  await page.reload();
});
await step('typing shows results grouped by app', async () => {
  await box().fill('zephyr');
  for (const g of ['Files', 'Chat', 'Tasks', 'Notes', 'Events', 'Contacts', 'People']) await results().getByRole('group', { name: g }).waitFor();
  await results().getByRole('group', { name: 'Files' }).getByText('Zephyr launch plan').waitFor();
  await page.screenshot({ path: `${SP}/shots/globalsearch.png` });
});
await step('pick a document', async () => {
  await results().getByRole('group', { name: 'Files' }).getByRole('option', { name: /Zephyr launch plan/ }).click();
  await page.waitForURL(/\/docs\//);
});
await step('keyboard: arrows and Enter open a task', async () => {
  await page.goto(`${B}/drive`);
  await box().fill('venue');
  await results().getByRole('group', { name: 'Tasks' }).waitFor();
  await box().press('ArrowDown');
  await box().press('Enter');
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('complementary', { name: 'Task details' }).waitFor();
});
await step('a note and an event open where they live', async () => {
  await box().fill('kites');
  await results().getByRole('option', { name: /Zephyr ideas/ }).click();
  await page.waitForURL(/\/notes$/);
  await page.getByRole('dialog', { name: 'Zephyr ideas' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await box().fill('review');
  await results().getByRole('option', { name: /Zephyr review/ }).click();
  await page.waitForURL(/\/calendar$/);
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
});
await step('Enter with nothing picked searches Drive; Escape closes', async () => {
  await page.goto(`${B}/drive`);
  await box().fill('launch');
  await results().waitFor();
  await box().press('Escape');
  if (await results().count()) throw new Error('still open');
  await box().focus();
  await box().press('Enter');
  await page.waitForURL(/\/drive\/search\?q=launch/);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
