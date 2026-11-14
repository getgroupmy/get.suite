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
const row = (p, n) => p.locator('.files tbody tr', { hasText: n }).first();
let kim;
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
const fromTemplate = async (p, label) => {
  await p.goto(`${B}/drive`);
  await p.getByRole('button', { name: 'New' }).click();
  await p.getByRole('menuitem', { name: 'From a template…' }).click();
  await p.getByRole('dialog', { name: 'New from a template' }).getByRole('button', { name: label }).click();
};
await step('Kim makes one of his documents his own template; it’s under My templates and starts a copy', async () => {
  await api(kim, 'POST', '/files/new', { kind: 'doc', name: 'Weekly report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wins this week' }] }] } });
  await kim.goto(`${B}/drive`);
  await row(kim, 'Weekly report').getByRole('button', { name: 'Actions for Weekly report' }).click();
  await kim.getByRole('menuitem', { name: 'Use as my template' }).click();
  await kim.getByText('Added to your templates').waitFor();
  await kim.getByRole('button', { name: 'New' }).click();
  await kim.getByRole('menuitem', { name: 'From a template…' }).click();
  const d = kim.getByRole('dialog', { name: 'New from a template' });
  await d.getByLabel('My templates').getByRole('button', { name: 'Weekly report (document)' }).waitFor();
  await kim.screenshot({ path: `${SP}/shots/mytemplates.png` });
  await d.getByLabel('My templates').getByRole('button', { name: 'Weekly report (document)' }).click();
  await kim.waitForURL(/\/docs\//);
  await kim.getByText('Wins this week').waitFor();
});
await step('Olivia doesn’t see Kim’s template', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'From a template…' }).click();
  const d = page.getByRole('dialog', { name: 'New from a template' });
  await d.getByText('Ready-made').waitFor();
  if (await d.getByText('Weekly report').count()) throw new Error('someone else’s template shows');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
