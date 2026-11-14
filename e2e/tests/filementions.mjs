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
let general, doc, first, reply, dm;
await step('a document linked in #general twice (once in a thread) and in a DM', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Roadmap' })).body;
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: `Draft: ${B}/docs/${doc.id}` });
  first = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Roadmap: ${B}/docs/${doc.id}` })).body;
  reply = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Updated /docs/${doc.id}`, parent_id: first.id })).body;
});
const section = () => page.getByRole('region', { name: 'Shared in Chat' });
await step('Drive → Details shows where it was shared, latest first, with how many times', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Roadmap').click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await section().waitFor();
  const rows = await section().locator('li').allInnerTexts();
  if (rows.length !== 2 || !/^# general\s+Olivia Owner · .+ · 2 times$/.test(rows[0]) || !/^Kim Park\s+Olivia Owner/.test(rows[1])) throw new Error(JSON.stringify(rows));
});
await step('clicking one opens Chat at that message, in its thread', async () => {
  await section().getByRole('button', { name: '# general' }).click();
  await page.waitForURL(`**/chat/${general}?msg=${reply.id}&thread=${first.id}`);
  await page.getByRole('dialog', { name: 'Details' }).waitFor({ state: 'detached' });
  await until(() => page.locator(`[data-mid="${reply.id}"]`).first().isVisible());
});
await step('a file never shared in Chat has no such section', async () => {
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quiet sheet' });
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Quiet sheet').click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await page.getByRole('dialog', { name: 'Details' }).getByText('Activity').first().waitFor();
  await page.waitForTimeout(500);
  if (await section().count()) throw new Error('shown');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
