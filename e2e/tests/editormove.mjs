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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

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
let doc, contracts;
await step('a document’s ⋮ → Move to…: find a folder, move it there, and Undo puts it back', async () => {
  const clients = (await api(page, 'POST', '/files/folder', { name: 'Clients' })).body;
  contracts = (await api(page, 'POST', '/files/folder', { name: 'Contracts', parent_id: clients.id })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lease draft', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Terms' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').getByText('Terms').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const d = page.getByRole('dialog', { name: 'Move “Lease draft”' });
  await d.getByLabel('Find a folder').fill('contr');
  await d.getByRole('list', { name: 'Folders found' }).getByRole('button', { name: /Contracts.*in Clients/ }).click();
  await d.getByRole('button', { name: 'Move here' }).click();
  await page.getByText('Moved to Contracts').waitFor();
  await until(async () => (await api(page, 'GET', `/files/${doc.id}`)).body.parent_id === contracts.id);
  await page.locator('.toasts').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Put back').waitFor();
  await until(async () => !(await api(page, 'GET', `/files/${doc.id}`)).body.parent_id);
  await page.locator('.ProseMirror').getByText('Terms').waitFor(); // still open, as it was
});
await step('a spreadsheet: Contracts is under Recent now, one click away', async () => {
  const book = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Rent book' })).body;
  await page.goto(`${B}/sheets/${book.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const d = page.getByRole('dialog', { name: 'Move “Rent book”' });
  await d.getByRole('list', { name: 'Recent folders' }).getByRole('button', { name: /Contracts/ }).click();
  await d.getByRole('button', { name: 'Move here' }).click();
  await page.getByText('Moved to Contracts').waitFor();
  await until(async () => (await api(page, 'GET', `/files/${book.id}`)).body.parent_id === contracts.id);
});
await step('someone who can only view isn’t offered Move to…', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error('user');
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: r.body.id, role: 'viewer' }] });
  const kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.locator('.ProseMirror').getByText('Terms').waitFor();
  await kim.getByRole('button', { name: 'More' }).click();
  await kim.getByRole('menuitem', { name: /Make a copy/ }).waitFor();
  if (await kim.getByRole('menuitem', { name: 'Move to…' }).count()) throw new Error('offered to a viewer');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
