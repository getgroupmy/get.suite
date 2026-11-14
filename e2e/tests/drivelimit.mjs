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
await step('the admin gives Kim a 1 MB Drive limit', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  await page.getByRole('menuitem', { name: 'Drive storage limit' }).click();
  const dlg = page.getByRole('dialog', { name: 'Drive storage for Kim Park' });
  await dlg.getByLabel(/Most they can store/).fill('1');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Kim Park can store up to 1 MB').waitFor();
  await page.getByRole('row', { name: /Kim Park/ }).getByText(/of 1(\.0)? MB/).waitFor();
});
await step('Kim sees her limit in Drive, and an upload over it is refused with why', async () => {
  const chunk = Buffer.alloc(700 * 1024, 1);
  await kim.goto(`${B}/drive`);
  const [fc] = await Promise.all([kim.waitForEvent('filechooser'), (async () => { await kim.getByRole('button', { name: 'New' }).click(); await kim.getByRole('menuitem', { name: /File upload|Upload files/ }).click(); })()]);
  await fc.setFiles({ name: 'first.bin', mimeType: 'application/octet-stream', buffer: chunk });
  await kim.getByText('first.bin').first().waitFor();
  const [fc2] = await Promise.all([kim.waitForEvent('filechooser'), (async () => { await kim.getByRole('button', { name: 'New' }).click(); await kim.getByRole('menuitem', { name: /File upload|Upload files/ }).click(); })()]);
  await fc2.setFiles({ name: 'second.bin', mimeType: 'application/octet-stream', buffer: chunk });
  await kim.getByText(/storage \(1 MB\) is full/).first().waitFor();
  await kim.getByRole('button', { name: 'Storage' }).click();
  const dlg = kim.getByRole('dialog');
  await dlg.getByText(/of 1(\.0)? MB \(your limit\)/).waitFor();
  await dlg.getByLabel('Your storage used').waitFor();
  await dlg.screenshot({ path: `${SP}/shots/drive-limit.png` });
});
errors.splice(0, errors.length, ...errors.filter((e) => !/status of 413/.test(e))); // the refused upload: expected
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
