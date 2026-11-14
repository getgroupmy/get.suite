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
await step('turn off notifications about things shared with you', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.getByRole('button', { name: 'Notifications' }).click();
  await kim.getByRole('button', { name: 'Notification settings' }).click();
  const d = kim.getByRole('dialog', { name: 'Notification settings' });
  await d.getByLabel('Files shared with you and access requests').uncheck();
  await kim.waitForTimeout(400);
  await d.getByRole('button', { name: 'Done' }).click();
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Quiet doc' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await api(page, 'POST', `/files/${doc.id}/mention`, { user_id: kimId });
  await until(async () => JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('mentioned you in “Quiet doc”'));
  if (JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('shared “Quiet doc”')) throw new Error('share notified');
  await kim.reload();
  await kim.getByRole('button', { name: /Notifications/ }).first().click();
  await kim.getByRole('button', { name: 'Notification settings' }).click();
  if (await kim.getByRole('dialog', { name: 'Notification settings' }).getByLabel('Files shared with you and access requests').isChecked()) throw new Error('not kept');
}, kim);
await step('your share links have their own switch', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await page.getByRole('button', { name: 'Notification settings' }).click();
  const d = page.getByRole('dialog', { name: 'Notification settings' });
  const sw = d.getByLabel(/Your share links: opened, ending soon/);
  if (!(await sw.isChecked())) throw new Error('off to start with');
  await sw.uncheck();
  await until(async () => (await api(page, 'GET', '/notifications/settings')).body.kinds.find((k) => k.kind === 'link').on === false);
  if (!(await d.getByLabel('Files shared with you and access requests').isChecked())) throw new Error('took sharing with it');
  await sw.check();
  await d.getByRole('button', { name: 'Done' }).click();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
