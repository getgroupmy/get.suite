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
let docId, sheetId, deckId;
const more = async () => page.getByRole('button', { name: 'More', exact: true }).click();
const hist = () => page.getByRole('dialog', { name: 'Version history' });
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
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Price: 10,000' }] }] } })).body.id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quote', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Total', B1: '=2*500' } }] } })).body.id;
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body.id;
});
await step('Docs: name the current version, then change the text', async () => {
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Price: 10,000').waitFor();
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: 'Name current version' }).click();
  await hist().getByLabel('Name for the file as it is now').fill('Sent to client');
  await hist().getByRole('button', { name: 'Save' }).click();
  await hist().getByRole('button', { name: /Sent to client/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.paper p', { hasText: 'Price' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' plus tax');
  await page.getByText('Price: 10,000 plus tax').waitFor();
  await page.waitForTimeout(2500);
});
await step('Show changes since then: the added words marked, with a count', async () => {
  await page.locator('.paper p', { hasText: 'Price' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Delivery in March.');
  await page.getByText('Delivery in March.').waitFor();
  await page.waitForTimeout(2500);
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /Sent to client/ }).click();
  await hist().locator('.versions-body').getByText('Price: 10,000', { exact: true }).waitFor();
  await hist().getByLabel('Show changes since then').check();
  const body = hist().locator('.versions-body');
  await body.getByText('Since then: 5 words added, 0 taken out.').waitFor();
  if ((await body.locator('ins').allInnerTexts()).map((t) => t.trim()).join('|') !== 'plus tax|Delivery in March.') throw new Error(await body.innerHTML());
  await body.locator('p.change-add', { hasText: 'Delivery in March.' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/doc-changes.png` });
  await hist().getByLabel('Show changes since then').uncheck();
  if (await body.locator('ins').count()) throw new Error('back to the plain preview');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
