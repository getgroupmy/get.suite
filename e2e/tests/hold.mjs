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
  p.on('console', (m) => m.type() === 'error' && !/40[0-49]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
const pat = await mk('pat');
let patId, docId;
await step('an admin puts someone on legal hold, with why', async () => {
  patId = (await api(page, 'POST', '/users', { local: 'pat', domain: 'acme.com', name: 'Pat Held', password: 'password123' })).body.id;
  await signIn(pat, 'pat@acme.com');
  docId = (await api(pat, 'POST', '/files/new', { kind: 'doc', name: 'Supplier contract notes' })).body.id;
  await api(pat, 'PATCH', `/files/${docId}`, { trashed: true });
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Pat Held' }).click();
  await page.getByRole('menuitem', { name: 'Put on legal hold…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Put Pat Held on legal hold' });
  await dlg.getByLabel('Why (for the record)').fill('Supplier dispute, case 2026-14');
  await dlg.getByRole('button', { name: 'Put on hold' }).click();
  const pill = page.getByRole('row', { name: /Pat Held/ }).getByText('On hold');
  await pill.waitFor();
  const tip = await pill.getAttribute('title');
  if (!/Supplier dispute, case 2026-14/.test(tip) || !/Olivia Owner/.test(tip)) throw new Error(tip);
  await page.screenshot({ path: `${SP}/shots/hold-admin.png` });
});
await step('they can\'t delete their trash for good, and are told why', async () => {
  await pat.goto(`${B}/drive/trash`);
  await pat.getByRole('row', { name: /Supplier contract notes/ }).getByText('Kept', { exact: true }).waitFor();
  await pat.getByRole('button', { name: 'Actions for Supplier contract notes' }).click();
  await pat.getByRole('menuitem', { name: 'Delete forever' }).click();
  const dlg = pat.getByRole('dialog', { name: 'Delete forever?' });
  await dlg.getByRole('button', { name: 'Delete forever' }).click();
  await dlg.getByText(/legal hold/).waitFor();
  await pat.screenshot({ path: `${SP}/shots/hold-drive.png` });
});
await step('their account can\'t be deleted until the hold is lifted', async () => {
  await page.getByRole('button', { name: 'Actions for Pat Held' }).click();
  await page.getByRole('menuitem', { name: 'Delete user and their files' }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete Pat Held?' });
  await dlg.getByRole('button', { name: 'Delete user' }).click();
  await dlg.getByText(/legal hold/).waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Actions for Pat Held' }).click();
  await page.getByRole('menuitem', { name: 'Lift legal hold' }).click();
  await page.getByRole('dialog', { name: 'Lift the legal hold on Pat Held?' }).getByText(/Supplier dispute/).waitFor();
  await page.getByRole('button', { name: 'Lift hold' }).click();
  await page.getByRole('row', { name: /Pat Held/ }).getByText('On hold').waitFor({ state: 'detached' });
  const r = await api(pat, 'DELETE', `/files/${docId}`);
  if (r.status !== 200) throw new Error(JSON.stringify(r));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
