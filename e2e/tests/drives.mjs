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
await step('Olivia makes a shared drive and adds Kim as an editor', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Shared drives' }).click();
  await page.getByText('No shared drives yet').waitFor();
  await page.getByRole('button', { name: 'New shared drive' }).click();
  await page.getByRole('dialog', { name: 'New shared drive' }).getByLabel('Name').fill('Marketing');
  await page.getByRole('dialog', { name: 'New shared drive' }).getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'Members of “Marketing”' });
  await dlg.getByText('Everyone added sees everything').waitFor();
  await dlg.getByLabel('Email address').fill('kim@acme.com');
  await dlg.getByLabel('Access', { exact: true }).selectOption('editor');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText('Kim Park').waitFor();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Shared drives' }).waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('heading', { name: 'My Drive' }).or(page.getByRole('navigation', { name: 'Folder path' })).first().waitFor();
  await page.waitForTimeout(500);
  if (await page.locator('tbody').getByText('Marketing', { exact: true }).count()) throw new Error('in My Drive');
});
await step('Kim finds it under Shared drives, adds a folder there, and manages its members', async () => {
  await kim.goto(`${B}/drive/drives`);
  await kim.locator('tbody').getByText('Marketing', { exact: true }).dblclick();
  await kim.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Marketing' }).waitFor();
  await kim.getByRole('button', { name: 'New', exact: true }).click();
  await kim.getByRole('menuitem', { name: 'New folder' }).click();
  await kim.getByRole('dialog', { name: 'New folder' }).getByLabel('Folder name').fill('Campaign assets');
  await kim.getByRole('dialog', { name: 'New folder' }).getByRole('button', { name: 'Create' }).click();
  await kim.locator('tbody').getByText('Campaign assets', { exact: true }).waitFor();
  await kim.getByRole('button', { name: 'Members' }).click();
  const dlg = kim.getByRole('dialog', { name: 'Members of “Marketing”' });
  await dlg.getByLabel(/Access for everyone at/).waitFor(); // an editor manages it
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});
await step('Olivia sees Kim’s folder in the drive', async () => {
  await page.goto(`${B}/drive/drives`);
  await page.locator('tbody').getByText('Marketing', { exact: true }).dblclick();
  await page.locator('tbody').getByText('Campaign assets', { exact: true }).waitFor();
});
await step('Kim deletes Olivia’s file in the drive: it’s in her trash, marked with the drive; she restores it', async () => {
  const drive = (await api(kim, 'GET', '/files?view=drives')).body[0];
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan', parent_id: drive.id });
  await kim.goto(`${B}/drive/folder/${drive.id}`);
  await kim.getByRole('button', { name: 'Actions for Launch plan' }).click();
  await kim.getByRole('menuitem', { name: 'Move to trash' }).click();
  await kim.goto(`${B}/drive/trash`);
  await kim.locator('tbody tr', { hasText: 'Launch plan' }).getByText('· in Marketing').waitFor();
  await kim.getByRole('button', { name: 'Actions for Launch plan' }).click();
  await kim.getByRole('menuitem', { name: 'Restore' }).click();
  await kim.getByText('Trash is empty').waitFor();
  await page.goto(`${B}/drive/folder/${drive.id}`);
  await page.locator('tbody').getByText('Launch plan', { exact: true }).waitFor();
});
await step('Olivia’s new file in the drive is in Kim’s Recent', async () => {
  const drive = (await api(kim, 'GET', '/files?view=drives')).body.find((d) => d.name === 'Marketing');
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Q4 forecast', parent_id: drive.id });
  await kim.goto(`${B}/drive/recent`);
  await kim.locator('tbody').getByText('Q4 forecast', { exact: true }).waitFor();
});
await step('An admin sees every shared drive and adds herself to one she isn’t in', async () => {
  await api(kim, 'POST', '/files/drives', { name: 'Design' });
  await page.goto(`${B}/admin?tab=drives`);
  const row = page.locator('tbody tr', { hasText: 'Design' });
  await row.getByText('Kim Park').waitFor();
  await page.locator('tbody tr', { hasText: 'Marketing' }).getByRole('button', { name: 'Open Marketing' }).waitFor();
  await row.getByRole('button', { name: 'Add me to Design' }).click();
  await page.getByRole('dialog', { name: 'Add yourself to “Design”?' }).getByRole('button', { name: 'Add me as an editor' }).click();
  await row.getByRole('button', { name: 'Open Design' }).click();
  await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Design' }).waitFor();
  await until(async () => JSON.stringify((await api(kim, 'GET', '/notifications')).body).includes('added themselves to the shared drive “Design”'));
});
await step('Kim leaves the company: her folder stays in the drive', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  await page.getByRole('menuitem', { name: 'Delete user and their files' }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete Kim Park?' });
  await dlg.getByText('What they added to shared drives stays there').waitFor();
  await dlg.getByRole('button', { name: 'Delete user' }).click();
  await page.getByText(/User deleted; \d+ items? kept in shared drives/).waitFor();
  await page.goto(`${B}/drive/drives`);
  await page.locator('tbody').getByText('Marketing', { exact: true }).dblclick();
  await page.locator('tbody').getByText('Campaign assets', { exact: true }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
