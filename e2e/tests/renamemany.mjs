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
await step('select several, Rename: find and replace and text after, previewed, then done', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Quarter' })).body.id;
  for (const name of ['Q3 plan', 'Q3 budget', 'Q3 review']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: folder });
  await page.goto(`${B}/drive/folder/${folder}`);
  for (const n of ['Q3 plan', 'Q3 budget']) await page.getByLabel(`Select ${n}`).check();
  const bar = page.getByRole('toolbar', { name: 'Selected files' });
  await bar.getByText('2 selected').waitFor();
  await bar.getByRole('button', { name: 'Rename' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename 2 items' });
  await dlg.getByLabel('Find').fill('q3');
  await dlg.getByLabel('Replace with').fill('Q4');
  await dlg.getByLabel('Add after').fill(' (draft)');
  const table = dlg.getByRole('table', { name: 'New names' });
  await table.getByText('Q4 plan (draft)').waitFor();
  await table.getByText('Q4 budget (draft)').waitFor();
  await page.screenshot({ path: `${SP}/shots/rename-many.png` });
  await dlg.getByRole('button', { name: 'Rename 2' }).click();
  await page.getByText('Renamed 2').waitFor();
  await page.getByText('Q4 plan (draft)').first().waitFor();
  await page.getByText('Q4 budget (draft)').first().waitFor();
  await page.getByText('Q3 review').first().waitFor(); // not selected: left as it was
  if (await page.getByText('Q3 plan', { exact: true }).count()) throw new Error('old name still there');
});
await step('rename several: a new name for all, numbered in order', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Trip' })).body.id;
  for (const name of ['img10', 'img2', 'img1']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: folder });
  await page.goto(`${B}/drive/folder/${folder}`);
  for (const n of ['img10', 'img2', 'img1']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Rename' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename 3 items' });
  await dlg.getByLabel('New name for all (optional)').fill('Holiday');
  await dlg.getByRole('checkbox', { name: 'Number them' }).check();
  const table = dlg.getByRole('table', { name: 'New names' });
  await table.getByRole('row', { name: /img1 Holiday 1/ }).waitFor();
  await table.getByRole('row', { name: /img2 Holiday 2/ }).waitFor();
  await table.getByRole('row', { name: /img10 Holiday 3/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/rename-many-number.png` });
  await dlg.getByRole('button', { name: 'Rename 3' }).click();
  await page.getByText('Renamed 3').waitFor();
  for (const n of ['Holiday 1', 'Holiday 2', 'Holiday 3']) await page.getByText(n, { exact: true }).first().waitFor();
});
await step('rename several, then Undo puts the names back', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Put back' })).body.id;
  for (const name of ['Alpha', 'Beta']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: folder });
  await page.goto(`${B}/drive/folder/${folder}`);
  for (const n of ['Alpha', 'Beta']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Rename' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename 2 items' });
  await dlg.getByLabel('Add before').fill('Old ');
  await dlg.getByRole('table', { name: 'New names' }).getByText('Old Alpha').waitFor();
  await dlg.getByRole('button', { name: 'Rename 2' }).click();
  await page.getByText('Old Alpha').first().waitFor();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Names put back').waitFor();
  await page.getByText('Alpha', { exact: true }).first().waitFor();
  await until(async () => (await page.getByText('Old Alpha').count()) === 0 && (await page.getByText('Old Beta').count()) === 0);
});
await step('trash several, Undo restores them; move several, Undo moves them back', async () => {
  const home = (await api(page, 'POST', '/files/folder', { name: 'Desk' })).body.id;
  const away = (await api(page, 'POST', '/files/folder', { name: 'Archive box', parent_id: home })).body.id;
  for (const name of ['Memo one', 'Memo two']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: home });
  await page.goto(`${B}/drive/folder/${home}`);
  const bar = page.getByRole('toolbar', { name: 'Selected files' });
  for (const n of ['Memo one', 'Memo two']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await bar.getByRole('button', { name: 'Trash' }).click();
  await page.getByText('Moved 2 to trash').waitFor();
  await until(async () => (await page.getByText('Memo one').count()) === 0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Restored 2').waitFor();
  await page.getByText('Memo one').first().waitFor();
  // Move both into the folder, then Undo.
  for (const n of ['Memo one', 'Memo two']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await bar.getByRole('button', { name: 'Move' }).click();
  const dlg = page.getByRole('dialog', { name: 'Move 2 items' });
  const box = dlg.locator('.pick-list').getByRole('button', { name: 'Archive box' });
  if (!(await box.count())) await dlg.locator('.pick-list').getByRole('button', { name: 'Desk' }).click();
  await box.click();
  await dlg.getByRole('button', { name: 'Move here' }).click();
  await page.getByText('Moved 2 items').waitFor();
  await until(async () => (await page.getByText('Memo one').count()) === 0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Moved back').waitFor();
  await page.getByText('Memo two').first().waitFor();
  const inside = (await api(page, 'GET', `/files?view=mine&parent=${away}`)).body;
  if (inside.length) throw new Error('still in the folder');
});
await step('copy several: Make a copy puts a copy of each next to it; Undo trashes the copies', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Forms box' })).body.id;
  for (const name of ['Letter', 'Invoice']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: folder });
  await page.goto(`${B}/drive/folder/${folder}`);
  for (const n of ['Letter', 'Invoice']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Make a copy' }).click();
  await page.getByText('Made 2 copies').waitFor();
  await page.getByText('Copy of Letter').first().waitFor();
  await page.getByText('Copy of Invoice').first().waitFor();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Copies moved to trash').waitFor();
  await until(async () => (await page.getByText('Copy of Letter').count()) === 0);
  await page.getByText('Letter', { exact: true }).first().waitFor();
});
await step('copy a folder: Make a copy from its menu copies what is in it; Undo trashes the copy', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Kit folder' })).body.id;
  const inner = (await api(page, 'POST', '/files/folder', { name: 'Inner bits', parent_id: folder })).body.id;
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Kit list', parent_id: inner });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Kit folder' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy' }).click();
  await page.getByText('Made a copy').waitFor();
  await page.getByText('Copy of Kit folder').first().waitFor();
  const copy = (await api(page, 'GET', '/files?view=mine')).body.find((f) => f.name === 'Copy of Kit folder');
  const kids = (await api(page, 'GET', `/files?view=mine&parent=${copy.id}`)).body;
  if (kids.length !== 1 || kids[0].name !== 'Inner bits') throw new Error(`copied ${JSON.stringify(kids.map((k) => k.name))}`);
  const deep = (await api(page, 'GET', `/files?view=mine&parent=${kids[0].id}`)).body;
  if (deep.length !== 1 || deep[0].name !== 'Kit list') throw new Error('the doc inside not copied');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Copies moved to trash').waitFor();
  await until(async () => (await page.getByText('Copy of Kit folder').count()) === 0);
  await page.getByText('Kit folder', { exact: true }).first().waitFor();
});
await step('Copy to: copies go into the folder picked, keeping their names; Undo trashes them', async () => {
  const src = (await api(page, 'POST', '/files/folder', { name: 'Source box' })).body.id;
  const dest = (await api(page, 'POST', '/files/folder', { name: 'Target box' })).body.id;
  for (const name of ['Plan A', 'Plan B']) await api(page, 'POST', '/files/new', { kind: 'doc', name, parent_id: src });
  await page.goto(`${B}/drive/folder/${src}`);
  for (const n of ['Plan A', 'Plan B']) await page.getByLabel(`Select ${n}`, { exact: true }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Copy to' }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy 2 items to…' });
  await dlg.locator('.pick-list').getByRole('button', { name: 'Target box' }).click();
  await dlg.getByRole('button', { name: 'Copy here' }).click();
  await page.getByText('Made 2 copies').waitFor();
  const inDest = async () => (await api(page, 'GET', `/files?view=mine&parent=${dest}`)).body.map((f) => f.name).sort().join();
  if (await inDest() !== 'Plan A,Plan B') throw new Error(`in the folder: ${await inDest()}`);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Copies moved to trash').waitFor();
  await until(async () => (await inDest()) === '');
  // One item from its menu.
  await page.getByRole('button', { name: 'Actions for Plan A' }).click();
  await page.getByRole('menuitem', { name: 'Copy to…' }).click();
  const one = page.getByRole('dialog', { name: 'Copy “Plan A” to…' });
  await one.getByRole('button', { name: 'Copy here' }).click();
  await page.getByText('Made a copy').waitFor();
  const mine = (await api(page, 'GET', '/files?view=mine')).body;
  if (!mine.some((f) => f.name === 'Plan A' && !f.parent_id)) throw new Error('not in My Drive');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
