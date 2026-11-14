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
const text = (p) => p.evaluate(() => { const el = document.querySelector('.paper .tiptap').cloneNode(true); el.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove()); return el.textContent; });
let docId, kim, vic;
await step('setup: a document shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (e) => dir.find((u) => u.username === e).id;
  const p = (...t) => ({ type: 'paragraph', content: t });
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract', content: { type: 'doc', content: [
    p({ type: 'text', text: 'The Supplier delivers. ' }, { type: 'text', text: 'Supplier', marks: [{ type: 'bold' }] }, { type: 'text', text: ' invoices monthly.' }),
    p({ type: 'text', text: 'Suppliers may subcontract; the supplier stays responsible.' }),
  ] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const pg of [page, kim, vic]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('invoices monthly').waitFor(); }
});

await step('Ctrl+F finds and highlights every match; Enter moves to the next', async () => {
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+f');
  await page.getByLabel('Find', { exact: true }).fill('supplier');
  await page.getByText('1 of 4').waitFor();
  if (await page.locator('.paper .find-match').count() !== 4) throw new Error('highlights');
  await page.getByLabel('Find', { exact: true }).press('Enter');
  await page.getByText('2 of 4').waitFor();
  await page.getByLabel('Find', { exact: true }).press('Shift+Enter');
  await page.getByText('1 of 4').waitFor();
  await page.getByLabel('Whole words').check();
  await page.getByText('1 of 3').waitFor();
  await page.getByLabel('Match case').check();
  await page.getByText('1 of 1').waitFor(); // only the lowercase whole word
  await page.getByLabel('Match case').uncheck();
  if (await kim.locator('.paper .find-match').count()) throw new Error('highlights are only for the person searching');
});

await step('replace one (keeps bold), then all; the others see it; one undo takes back all', async () => {
  await page.getByRole('button', { name: 'Replace…' }).click();
  await page.getByLabel('Replace with').fill('Vendor');
  await page.getByRole('button', { name: 'Next match' }).click(); // the bold one
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await kim.locator('.paper strong', { hasText: 'Vendor' }).waitFor();
  await page.getByRole('button', { name: 'Replace all' }).click();
  await page.getByText('No results').waitFor();
  await until(async () => (await text(kim)) === 'The Vendor delivers. Vendor invoices monthly.Suppliers may subcontract; the Vendor stays responsible.');
  await page.keyboard.press('Escape');
  await page.locator('.find-bar').waitFor({ state: 'detached' });
  await page.keyboard.press('Control+z');
  if (!(await page.evaluate(() => document.activeElement.classList.contains('ProseMirror')))) throw new Error('the document did not get the focus back');
  await until(async () => (await text(kim)) === 'The Supplier delivers. Vendor invoices monthly.Suppliers may subcontract; the supplier stays responsible.');
});

await step('Ctrl+H opens replace; viewers can find but not replace', async () => {
  await page.keyboard.press('Control+h');
  await page.getByLabel('Replace with').waitFor();
  await page.keyboard.press('Escape');
  await vic.locator('.paper .tiptap').click();
  await vic.keyboard.press('Control+h');
  await vic.getByLabel('Find', { exact: true }).fill('vendor');
  await vic.getByText('1 of 1').waitFor();
  if (await vic.getByLabel('Replace with').count() || await vic.getByRole('button', { name: 'Replace…' }).count()) throw new Error('viewer can replace');
});

await step('word count', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  const cellOf = (row) => dlg.locator(`tr:has(th:text-is("${row}"))`).locator('td').last().innerText();
  await until(async () => (await cellOf('Words')) === '13' && (await cellOf('Characters excluding spaces')) === '94');
  await page.screenshot({ path: `${SP}/shots/findreplace.png` });
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
