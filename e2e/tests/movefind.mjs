import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;

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

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
await step('people', async () => {
  for (const [local, name] of [['kim', 'Kim Park']]) if ((await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' });
});
await step('Move to…: find a folder by name, deep down, and move there', async () => {
  const mk2 = async (name, parent_id) => (await api(page, 'POST', '/files/folder', { name, ...(parent_id && { parent_id }) })).body;
  const clients = await mk2('Clients');
  const acme = await mk2('Acme', clients.id);
  const contracts = await mk2('Contracts', acme.id);
  await mk2('Contracts'); // another one, at the top: told apart by where it is
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lease 2027' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Lease 2027' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dlg = page.getByRole('dialog', { name: /Move “Lease 2027”/ });
  await dlg.getByLabel('Find a folder').fill('contra');
  const found = dlg.getByRole('list', { name: 'Folders found' });
  await found.getByRole('button').filter({ hasText: 'in Acme' }).waitFor();
  if (await found.getByRole('button').count() !== 2) throw new Error('both Contracts folders');
  await found.getByRole('button').filter({ hasText: 'in My Drive' }).waitFor(); // the one at the top
  await page.screenshot({ path: `${SP}/shots/move-find.png` });
  await found.getByRole('button').filter({ hasText: 'in Acme' }).click();
  await dlg.locator('.crumbs').getByRole('button', { name: 'Acme' }).waitFor(); // where it is now: My Drive › Clients › Acme › Contracts
  await dlg.locator('.crumbs').getByRole('button', { name: 'Contracts' }).waitFor();
  await dlg.getByRole('button', { name: 'Move here' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await api(page, 'GET', `/files/${doc.id}`)).body?.parent_id === contracts.id || (await api(page, 'GET', `/files?view=mine&parent=${contracts.id}`)).body.some((f) => f.id === doc.id));
});
await step('a folder only shared to view is not offered', async () => {
  // Kim shares a folder with Olivia to view: she can't move things into it.
  const kimCtx = await mk('kim');
  await kimCtx.goto(B);
  await kimCtx.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  const ro = (await api(kimCtx, 'POST', '/files/folder', { name: 'Contracts archive' })).body;
  const oliviaId = (await api(page, 'GET', '/auth/me')).body.user.id;
  await api(kimCtx, 'PUT', `/files/${ro.id}/shares`, { shares: [{ user_id: oliviaId, role: 'viewer' }] });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dlg = page.getByRole('dialog', { name: /Move “Plan”/ });
  await dlg.getByLabel('Find a folder').fill('contracts');
  const found = dlg.getByRole('list', { name: 'Folders found' });
  await found.getByRole('button').first().waitFor();
  if (await found.getByRole('button').filter({ hasText: 'Contracts archive' }).count()) throw new Error('a view-only folder was offered');
  await dlg.getByLabel('Find a folder').fill('zzqq');
  await found.getByText('No folder you can add to is called that').waitFor();
  await dlg.getByLabel('Find a folder').fill('');
  await dlg.getByText('My Drive').first().waitFor(); // back to walking the folders
});

await step('Drive search: each result says the folder it is in; a click opens that folder', async () => {
  await page.goto(`${B}/drive/search?q=${encodeURIComponent('lease')}`);
  const row = page.locator('table.files tbody tr', { hasText: 'Lease 2027' });
  await row.getByRole('button', { name: 'in Contracts' }).click();
  await page.waitForURL(/\/drive\/folder\//);
  await page.locator('table.files tbody').getByText('Lease 2027').waitFor();
  await page.locator('.crumbs, nav').getByText('Acme').first().waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
