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
await step('the platform owner sees the System tab with each check and the facts', async () => {
  await page.goto(`${B}/admin?tab=system`);
  const checks = page.getByRole('list', { name: 'Checks' });
  await checks.getByRole('listitem', { name: 'Disk space' }).getByText(/GB free of/).waitFor();
  await checks.getByRole('listitem', { name: 'Database snapshots' }).waitFor();
  await page.getByRole('status', { name: 'Overall health' }).locator('strong').getByText(/Everything looks fine|looked at soon|needs attention/).waitFor();
  await page.getByText('People', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('button', { name: 'Check again' }).waitFor();
});
await step('the platform owner takes a snapshot and downloads it', async () => {
  await page.getByRole('button', { name: 'Take a snapshot now' }).click();
  const d = new Date();
  const name = `workspace-${d.toISOString().slice(0, 10)}.db`;
  const row = page.getByRole('list', { name: 'Snapshots' }).getByRole('listitem', { name });
  await row.waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: `Download ${name}` }).click()]);
  if (dl.suggestedFilename() !== name) throw new Error(dl.suggestedFilename());
  const fsx = await import('node:fs');
  const p = await dl.path();
  if (fsx.readFileSync(p).subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('not a database');
});
await step('the files check finds an unused file to remove and a missing one', async () => {
  const fsx = await import('node:fs'); const pathx = await import('node:path');
  const dir = pathx.join(SP, 'data', 'files');
  const up = await page.evaluate(async () => (await fetch('/api/files/upload?name=Contract.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: '%PDF-1.4 x' })).json());
  const before = new Set(fsx.readdirSync(dir));
  // Contract.pdf's data goes missing; a leftover nobody refers to appears (written two hours ago).
  for (const f of before) fsx.rmSync(pathx.join(dir, f));
  fsx.writeFileSync(pathx.join(dir, 'leftover-blob'), 'x'.repeat(2048));
  const t = Date.now() / 1000 - 7200; fsx.utimesSync(pathx.join(dir, 'leftover-blob'), t, t);
  await page.goto(`${B}/admin?tab=system`);
  await page.getByRole('button', { name: 'Check files' }).click();
  const list = page.getByRole('list', { name: 'Files check' });
  await list.getByRole('listitem', { name: 'Unused files' }).getByText('1 unused file, 2.0 KB').waitFor();
  await list.getByRole('listitem', { name: 'Missing files' }).getByText('Contract.pdf (Olivia Owner)').waitFor();
  await list.getByRole('button', { name: 'Remove them' }).click();
  await page.getByRole('dialog', { name: 'Remove unused files?' }).getByRole('button', { name: 'Remove' }).click();
  await list.getByText('No unused files').waitFor();
  if (fsx.existsSync(pathx.join(dir, 'leftover-blob'))) throw new Error('still on disk');
  void up;
});
await step('a company admin or user doesn’t get it', async () => {
  await kim.goto(`${B}/admin?tab=system`);
  if (await kim.getByRole('tab', { name: 'System' }).count()) throw new Error('tab shown');
  if ((await api(kim, 'GET', '/orgs/system/health')).status !== 403) throw new Error('not 403');
  if ((await api(kim, 'GET', '/orgs/system/backups')).status !== 403) throw new Error('backups not 403');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
