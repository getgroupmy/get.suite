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
await step('search in Drive finds a document by the words inside it, with where it matched', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board minutes', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The board approved the new Penang warehouse lease for three years.' }] }] } });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Penang trip', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Packing list' }] }] } });
  await page.waitForTimeout(2500); // the index catches up
  await page.getByLabel('Search everything').fill('penang');
  await page.getByLabel('Search everything').press('Enter');
  const rows = page.locator('.files tbody tr');
  await rows.filter({ hasText: 'Board minutes' }).waitFor();
  // (results come in as they're found: wait for the list to settle with the name match on top)
  for (let end = Date.now() + 8000; !(await rows.first().textContent()).includes('Penang trip'); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('the name match should come first');
  await rows.filter({ hasText: 'Board minutes' }).locator('mark', { hasText: 'Penang' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/search.png` });
  await rows.filter({ hasText: 'Board minutes' }).locator('td.name').dblclick();
  await page.getByText('The board approved').waitFor();
  // A document opens with its find bar on the word, at the first match
  if ((await page.getByRole('search', { name: 'Find in document' }).getByLabel('Find', { exact: true }).inputValue()) !== 'penang') throw new Error('find bar');
  await page.locator('.find-match.current', { hasText: /Penang/i }).waitFor();
  await page.keyboard.press('Escape');
});

await step('a presentation matched by its words says which slide, and opens there; a spreadsheet, which cell', async () => {
  await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Expansion deck', content: { slides: [{ id: 'e1', items: [{ id: 'i1', type: 'text', text: 'Hello', x: 0, y: 0, w: 50, h: 10 }] }, { id: 'e2', items: [{ id: 'i2', type: 'text', text: 'Opening in Kuching next spring', x: 0, y: 0, w: 50, h: 10 }] }] } });
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Travel ledger', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'x' } }, { name: 'Trips', cells: { C3: 'Kuching flights' } }] } });
  await page.waitForTimeout(2500); // the index catches up
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('kuching');
  await page.getByLabel('Search everything').press('Enter');
  const rows = page.locator('.files tbody tr');
  await rows.filter({ hasText: 'Expansion deck' }).getByText('Slide 2').waitFor();
  await rows.filter({ hasText: 'Travel ledger' }).getByText('Trips · C3').waitFor();
  await rows.filter({ hasText: 'Expansion deck' }).locator('td.name').dblclick();
  await page.getByText('Slide 2 of 2').waitFor();
  await page.goBack();
  await rows.filter({ hasText: 'Travel ledger' }).locator('td.name').dblclick();
  await page.locator('[data-k="C3"]').getByText('Kuching flights').waitFor();
  await until(async () => (await page.getByLabel('Name box').inputValue()) === 'C3');
});
await step('an uploaded PDF is found by the words inside it, with them marked', async () => {
  // a PDF made the way another program would hand it over: uploaded as a file
  const { pdfFromDoc } = await import(new URL('../../server/src/office/pdfdoc.js', import.meta.url).href);
  const bytes = await pdfFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The tenancy for the Sibu depot ends in March.' }] }] }, 'Tenancy');
  await page.evaluate(async (b) => fetch('/api/files/upload?name=Tenancy.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: new Uint8Array(b) }), Array.from(bytes));
  await page.waitForTimeout(2500); // the index catches up
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('sibu depot');
  await page.getByLabel('Search everything').press('Enter');
  const row = page.locator('.files tbody tr').filter({ hasText: 'Tenancy.pdf' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('mark', { hasText: 'Sibu' }).waitFor();
});
await step('an email kept in Drive (.eml) is found by the words in it, with them marked', async () => {
  const eml = ['From: Kim Park <kim@client.example>', 'To: olivia@acme.com', 'Subject: Rambutan delivery', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'The durian crates arrive at the Kuching yard on Tuesday.', ''].join('\r\n');
  await page.evaluate(async (b) => fetch('/api/files/upload?name=delivery.eml', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: b }), eml);
  await page.waitForTimeout(2500); // the index catches up
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('kuching yard');
  await page.getByLabel('Search everything').press('Enter');
  const row = page.locator('.files tbody tr').filter({ hasText: 'delivery.eml' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('mark', { hasText: 'Kuching' }).waitFor();
});
await step('Chinese: a word inside a sentence (no spaces between words) is found, and marked as written', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: '季度总结', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第三季度销售报告已经完成。' }] }] } });
  await page.waitForTimeout(2500); // the index catches up
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('销售报告');
  await page.getByLabel('Search everything').press('Enter');
  const row = page.locator('.files tbody tr').filter({ hasText: '季度总结' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('mark', { hasText: '销售报告' }).waitFor();
  if (!(await row.innerText()).includes('销售报告已经完成')) throw new Error(`the extract reads: ${await row.innerText()}`);
});
await step('Thai: a word inside a sentence (split by its dictionary) is found and marked', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'รายงาน', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'รายงานการขายประจำไตรมาส' }] }] } });
  await page.waitForTimeout(2500); // the index catches up
  await page.goto(`${B}/drive`);
  await page.getByLabel('Search everything').fill('การขาย');
  await page.getByLabel('Search everything').press('Enter');
  const row = page.locator('.files tbody tr').filter({ hasText: 'รายงานการขายประจำไตรมาส' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('mark', { hasText: 'การขาย' }).waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
