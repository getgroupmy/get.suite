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
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
// A big folder is put on the page a batch at a time, without losing anything: more on scrolling, End goes to
// the last file, Select all ticks every one.
let folder;
await step('a folder of 450 documents shows the first 200 at once, and how many more there are', async () => {
  folder = (await api(page, 'POST', '/files/folder', { name: 'Archive' })).body;
  for (let i = 0; i < 450; i += 50) await page.evaluate(async ([from, parent]) => Promise.all(Array.from({ length: 50 }, (_, k) => fetch('/api/files/new', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'doc', name: `Report ${String(from + k).padStart(3, '0')}`, parent_id: parent }) }))), [i, folder.id]);
  await page.goto(`${B}/drive/folder/${folder.id}`);
  await page.locator('table.files').getByText('Report 000', { exact: true }).waitFor();
  const rows = await page.locator('table.files tbody tr').count();
  if (rows !== 200) throw new Error(`${rows} rows`);
  await page.getByRole('button', { name: 'Show 200 more of 250' }).waitFor();
});
await step('scrolling to the end of the list brings in more; the button does too', async () => {
  await page.locator('.more-files').scrollIntoViewIfNeeded();
  await until(async () => (await page.locator('table.files tbody tr').count()) >= 400);
  await page.getByRole('button', { name: 'Show 50 more of 50' }).click();
  await until(async () => (await page.locator('table.files tbody tr').count()) === 450);
  if (await page.locator('.more-files').count()) throw new Error('still offers more');
});
await step('End goes to the very last file (all of them put on the page first); Select all ticks all 450', async () => {
  await page.reload();
  await page.locator('table.files').getByText('Report 000', { exact: true }).waitFor();
  await page.locator('table.files tbody tr').first().focus();
  await page.keyboard.press('End');
  await until(async () => (await page.evaluate(() => document.activeElement?.innerText || '')).includes('Report 449'));
  await page.locator('table.files thead input[type=checkbox]').check();
  await page.getByText('450 selected').waitFor();
});
await step('the folder’s list and the app’s scripts come gzipped', async () => {
  const got = [];
  page.on('response', async (r) => { if (/\/api\/files\?.*parent=|\/assets\/.*\.js$/.test(r.url())) got.push({ url: r.url(), enc: (await r.allHeaders())['content-encoding'], size: Number((await r.allHeaders())['content-length'] || 0) }); });
  await page.goto(`${B}/drive/folder/${folder.id}`);
  await page.locator('table.files').getByText('Report 000', { exact: true }).waitFor();
  const list = got.find((x) => x.url.includes('/api/files'));
  const js = got.find((x) => x.url.includes('/assets/'));
  if (list?.enc !== 'gzip') throw new Error(`list: ${JSON.stringify(list)}`);
  if (js && js.enc !== 'gzip') throw new Error(`script: ${JSON.stringify(js)}`);
  const full = (await api(page, 'GET', `/files?parent=${folder.id}`)).body;
  console.log(`  list of 450: ${JSON.stringify(full).length} bytes of JSON, ${list.size} sent`);
});
const seed = (url, n, make) => page.evaluate(async ([u, n2, src]) => { const mk = eval(src); for (let i = 0; i < n2; i += 50) await Promise.all(Array.from({ length: Math.min(50, n2 - i) }, (_, k) => fetch('/api' + u, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify(mk(i + k)) }))); }, [url, n, make.toString()]);
await step('Notes: 350 notes show 150 at first, more on scrolling; searching still finds one not on the page yet', async () => {
  await seed('/notes', 350, (i) => ({ title: `Idea ${String(i).padStart(3, '0')}`, body: 'text' }));
  await page.goto(`${B}/notes`);
  await page.locator('article.note-card').nth(10).waitFor();
  const n = await page.locator('article.note-card').count();
  if (n !== 150) throw new Error(`${n} notes on the page`);
  await page.getByRole('button', { name: 'Show 150 more of 200' }).waitFor();
  await page.locator('.more-files').scrollIntoViewIfNeeded();
  await until(async () => (await page.locator('article.note-card').count()) >= 300);
  await page.reload();
  await page.locator('article.note-card').nth(10).waitFor();
  const onPage = new Set((await page.locator('article.note-card').allInnerTexts()).map((t) => (t.match(/Idea \d{3}/) || [])[0]));
  const missing = Array.from({ length: 350 }, (_, i) => `Idea ${String(i).padStart(3, '0')}`).find((t) => !onPage.has(t));
  if (!missing) throw new Error('all on the page');
  await page.getByLabel('Search notes').fill(missing);
  await until(async () => (await page.locator('article.note-card', { hasText: missing }).count()) === 1);
});
await step('Contacts: 450 contacts fill the table 200 rows at a time; the filter searches all of them', async () => {
  await seed('/contacts', 450, (i) => ({ name: `Person ${String(i).padStart(3, '0')}`, email: `p${i}@example.com` }));
  await page.goto(`${B}/contacts`);
  await page.locator('tbody tr[data-contact]').nth(10).waitFor();
  const n = await page.locator('tbody tr[data-contact]').count();
  if (n !== 200) throw new Error(`${n} rows`);
  if (!(await page.locator('.more-files').innerText()).includes('more of 250')) throw new Error(await page.locator('.more-files').innerText());
  // More come in as the end nears the screen, or with the button (whichever is first: both are fine).
  await page.locator('.more-files button').click({ timeout: 5000 }).catch(() => {});
  await until(async () => (await page.locator('tbody tr[data-contact]').count()) >= 400);
  await page.reload();
  await page.locator('tbody tr[data-contact]').nth(10).waitFor();
  await page.getByPlaceholder('Filter', { exact: true }).fill('Person 44');
  await until(async () => (await page.locator('tbody tr[data-contact]', { hasText: 'Person 449' }).count()) === 1);
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
