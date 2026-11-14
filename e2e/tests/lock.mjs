import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let doc, sheet, kim;
const lockBanner = (p) => p.getByRole('region', { name: 'Locked' });
await step('a document and a spreadsheet shared for editing', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Final report' })).body;
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget' })).body;
  for (const f of [doc, sheet]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
});
await step('lock the document from its menu', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Signed off.');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Lock (stop changes)' }).click();
  await lockBanner(page).getByText(/Locked by you/).waitFor();
  await page.locator('.ProseMirror[contenteditable="false"]').waitFor();
  await page.locator('.ProseMirror').getByText('Signed off.').waitFor();
});
await step('an editor can read it but not change it, and cannot unlock it', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await lockBanner(kim).getByText(/Locked by Olivia Owner/).waitFor();
  await kim.locator('.ProseMirror[contenteditable="false"]').waitFor();
  if (await lockBanner(kim).getByRole('button', { name: 'Unlock' }).count()) throw new Error('editor should not unlock');
});
await step('Drive shows the lock; unlock from the banner and the editor is editable again (live)', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('row', { name: /Final report/ }).getByLabel('Locked').waitFor();
  await page.goto(`${B}/docs/${doc.id}`);
  await lockBanner(page).getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
  if (await lockBanner(page).count()) throw new Error('banner should go');
  await kim.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 15000 });
});
await step('an editor locks the spreadsheet from Drive; the sheet is read-only', async () => {
  await kim.goto(`${B}/drive/shared`);
  await kim.getByRole('button', { name: 'Actions for Budget' }).click();
  await kim.getByRole('menuitem', { name: 'Lock (stop changes)' }).click();
  await kim.getByText(/Locked: nobody can change it/).waitFor();
  await page.goto(`${B}/sheets/${sheet.id}`);
  await lockBanner(page).getByText(/Locked by Kim Park/).waitFor();
  // The owner can unlock what an editor locked.
  await lockBanner(page).getByRole('button', { name: 'Unlock' }).waitFor();
  const r = await api(page, 'PUT', `/files/${sheet.id}/content`, { content: { sheets: [] }, version: 1 });
  if (r.status !== 423) throw new Error(`expected 423, got ${r.status}`);
});
errors = errors.filter((e) => !/423/.test(e));
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
