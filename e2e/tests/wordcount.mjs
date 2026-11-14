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
let docId, kim;
const counter = (p) => p.locator('.word-counter');
const cellOf = (dlg, row, col) => dlg.locator(`tr:has(th:text-is("${row}"))`).locator('td').nth(col);
await step('setup: a document shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly figures' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'The figures for the third quarter are in here.' }] },
  ] };
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('third quarter').waitFor(); }
});
await step('Word count in the menu: the counts, and turning on the counter', async () => {
  if (await counter(page).count()) throw new Error('no counter at first');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  await until(async () => (await cellOf(dlg, 'Words', 0).innerText()) === '11');
  const got = await Promise.all(['Characters', 'Characters excluding spaces', 'Paragraphs', 'Reading time'].map((r) => cellOf(dlg, r, 0).innerText()));
  if (got.join('|') !== '63|54|2|1 min') throw new Error(got.join('|'));
  if (await dlg.getByRole('columnheader', { name: 'Selection' }).count()) throw new Error('no selection column without a selection');
  await dlg.getByLabel('Display word count while typing').check();
  await dlg.getByRole('button', { name: 'OK' }).click();
  await until(async () => (await counter(page).innerText()) === '11 words');
});
await step('the counter follows typing, and counts the selection', async () => {
  await page.getByText('third quarter').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Three more words');
  await until(async () => (await counter(page).innerText()) === '14 words');
  await page.locator('.ProseMirror h1').dblclick({ position: { x: 40, y: 20 } });
  await until(async () => (await counter(page).innerText()) === '1 of 14 words');
  await page.screenshot({ path: `${SP}/shots/wordcount-counter.png` });
});
await step('Ctrl+Shift+C shows the selection beside the document; clicking the counter opens it too', async () => {
  await page.keyboard.press('Control+Shift+C');
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  await dlg.getByRole('columnheader', { name: 'Selection' }).waitFor();
  const words = [await cellOf(dlg, 'Words', 0).innerText(), await cellOf(dlg, 'Words', 1).innerText()];
  if (words.join('|') !== '1|14') throw new Error(words.join('|'));
  await page.screenshot({ path: `${SP}/shots/wordcount-dialog.png` });
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  await counter(page).click();
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'OK' }).click();
});
await step('the counter is remembered in this browser only', async () => {
  await page.reload();
  await page.getByText('third quarter').waitFor();
  await until(async () => (await counter(page).count()) && (await counter(page).innerText()) === '14 words');
  if (await counter(kim).count()) throw new Error('Kim did not turn it on');
});
await step('Drive Details give the document’s length', async () => {
  await kim.goto(`${B}/drive/shared`);
  const row = kim.locator('.files tbody tr', { hasText: 'Report' }).first();
  await row.getByRole('button', { name: 'Actions for Report' }).click();
  await kim.getByRole('menuitem', { name: 'Details' }).click();
  const dlg = kim.getByRole('dialog', { name: 'Details' });
  await dlg.getByText('14 words · 1 min read').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
