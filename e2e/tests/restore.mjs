import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
// e2e-restart (a restore stops the server; like Docker, it is started again)
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
  

});
await step('a snapshot is put back: the app restarts with it, and what came after is gone', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Before the snapshot' });
  await api(page, 'POST', '/orgs/system/backups');
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'After the snapshot' });
  await page.goto(`${B}/admin?tab=system`);
  const name = `workspace-${new Date().toISOString().slice(0, 10)}.db`;
  await page.getByRole('button', { name: `Restore ${name}` }).click();
  const dlg = page.getByRole('dialog', { name: `Restore ${name}?` });
  await dlg.getByRole('button', { name: 'Restore and restart' }).click();
  await dlg.getByText(/Type \d{4}-\d{2}-\d{2} to confirm/).waitFor();
  await dlg.getByLabel(/Type the snapshot’s date/).fill(name.slice(10, 20));
  await dlg.getByRole('button', { name: 'Restore and restart' }).click();
  await page.getByText(`Restoring ${name}: Workspace is restarting`).waitFor();
  await page.waitForEvent('load', { timeout: 30000 }); // reloaded once it's back
  await page.goto(`${B}/drive`);
  await page.locator('tbody').getByText('Before the snapshot', { exact: true }).waitFor();
  if (await page.locator('tbody').getByText('After the snapshot', { exact: true }).count()) throw new Error('still there');
  const list = (await api(page, 'GET', '/orgs/system/backups')).body.map((b) => b.name);
  if (!list.some((n) => /-before-restore-\d{6}\.db$/.test(n))) throw new Error(`no copy kept: ${list}`);
  const notes = JSON.stringify((await api(page, 'GET', '/notifications')).body);
  if (!notes.includes(`The database was restored from ${name}`)) throw new Error('not told');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
