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

const doc = (name, text) => api(page, 'POST', '/files/new', { kind: 'doc', name, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }).then((r) => r.body);
let a, b, book;
await step('a document’s ⋮ → Open… lists recent files (not this one); picking a document opens it', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Plans' })).body;
  a = await doc('Plan A', 'Alpha words');
  b = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan B', parent_id: folder.id, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bravo words' }] }] } })).body;
  book = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Plan figures', content: { sheets: [{ name: 'One', cells: { A1: 'Charlie' } }] } })).body;
  await page.goto(`${B}/docs/${a.id}`);
  await page.locator('.ProseMirror').getByText('Alpha words').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Open…' }).click();
  const d = page.getByRole('dialog', { name: 'Open a file' });
  await d.getByRole('button', { name: /Plan B · in Plans/ }).waitFor();
  if (await d.getByRole('button', { name: /^Plan A/ }).count()) throw new Error('offers the file already open');
  await d.getByRole('button', { name: /Plan B/ }).click();
  await page.waitForURL(`**/docs/${b.id}`);
  await page.locator('.ProseMirror').getByText('Bravo words').waitFor(); // its own words, not the last one's
  if (await page.locator('.ProseMirror').getByText('Alpha words').count()) throw new Error('still showing Plan A');
});
await step('Ctrl+O opens the same window; a spreadsheet found by searching opens in Sheets', async () => {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+o');
  const d = page.getByRole('dialog', { name: 'Open a file' });
  await d.getByLabel('Search your files').fill('figures');
  await d.getByRole('button', { name: /Plan figures/ }).click();
  await page.waitForURL(`**/sheets/${book.id}`);
  await page.locator('.grid td[data-k="A1"]').getByText('Charlie').waitFor();
  // and from the spreadsheet, Escape closes it without going anywhere
  await page.keyboard.press('Control+o');
  await d.waitFor();
  await page.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
  if (!page.url().endsWith(`/sheets/${book.id}`)) throw new Error('moved: ' + page.url());
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
