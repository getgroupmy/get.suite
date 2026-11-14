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
await step('preview the named version, and restore it', async () => {
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /Sent to client/ }).click();
  await hist().locator('.versions-body').getByText('Price: 10,000', { exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/history.png` });
  await hist().getByRole('button', { name: 'Restore this version' }).click();
  await until(async () => (await page.locator('.paper .tiptap').first().innerText()).trim() === 'Price: 10,000', 15000);
});
await step('what was there before the restore is kept as a version too', async () => {
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await until(async () => (await hist().locator('.version-item').count()) >= 2);
  await hist().locator('.version-item').first().click();
  await hist().locator('.versions-body').getByText('Price: 10,000 plus tax').waitFor();
  await page.keyboard.press('Escape');
});
await step('Sheets: the preview shows the values', async () => {
  await api(page, 'POST', `/files/${sheetId}/versions/name`, { label: 'First quote' });
  await page.goto(`${B}/sheets/${sheetId}`);
  await page.locator('[data-k="A1"]', { hasText: 'Total' }).waitFor();
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /First quote/ }).click();
  await hist().locator('.grid-preview td', { hasText: '1000' }).waitFor();
  await page.keyboard.press('Escape');
});
await step('Slides: the preview shows the slides', async () => {
  await api(page, 'POST', `/files/${deckId}/versions/name`, { label: 'Draft 1' });
  await page.goto(`${B}/slides/${deckId}`);
  await more(); await page.getByRole('menuitem', { name: 'Version history' }).click();
  await hist().getByRole('button', { name: /Draft 1/ }).click();
  await hist().locator('.deck-preview-slide').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
