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
const items = (p = page) => p.locator('.doc-outline li button').allInnerTexts();
let docId, kim;
await step('setup: a long document with headings, shared with an editor', async () => {
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
  const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
  const filler = Array.from({ length: 25 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Filler paragraph ${i} with enough words to take up some room on the page.` }] }));
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Handbook', content: { type: 'doc', content: [
    h(1, 'Welcome'), ...filler.slice(0, 8), h(2, 'Holidays'), ...filler.slice(8, 16), h(2, 'Expenses'), ...filler.slice(16), h(1, 'Leaving'), { type: 'paragraph', content: [{ type: 'text', text: 'The end.' }] },
  ] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const pg of [page, kim]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('The end.').waitFor(); }
});
const tocItems = (p = page) => p.locator('.paper nav.doc-toc li a').allInnerTexts();
await step('Contents inserts a list of the headings at the cursor', async () => {
  await page.getByText('Filler paragraph 0 with').click();
  await page.keyboard.press('Home');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Insert table of contents' }).click();
  await page.locator('.paper nav.doc-toc').waitFor();
  const got = await tocItems();
  if (got.join('|') !== 'Welcome|Holidays|Expenses|Leaving') throw new Error(got.join('|'));
  const pad = await page.locator('.paper nav.doc-toc li').nth(1).evaluate((el) => el.style.paddingLeft);
  if (pad !== '1.5em') throw new Error('indent ' + pad);
  await page.screenshot({ path: `${SP}/shots/toc.png` });
});
await step('the list follows heading changes, for the other editor too', async () => {
  await until(async () => (await tocItems(kim)).join('|') === 'Welcome|Holidays|Expenses|Leaving');
  await kim.locator('.paper h2', { hasText: 'Expenses' }).click();
  await kim.keyboard.press('End');
  await kim.waitForTimeout(250);
  await kim.keyboard.type(' and travel');
  await until(async () => (await tocItems()).join('|') === 'Welcome|Holidays|Expenses and travel|Leaving');
  await until(async () => (await tocItems(kim)).join('|') === 'Welcome|Holidays|Expenses and travel|Leaving');
});
await step('clicking an entry goes to its heading', async () => {
  await page.locator('.paper nav.doc-toc a', { hasText: 'Leaving' }).click();
  await until(async () => { const top = await page.locator('.paper h1', { hasText: 'Leaving' }).evaluate((el) => el.getBoundingClientRect().top); return top > 0 && top < 860; }, 4000);
  await page.keyboard.type(' soon');
  await until(async () => (await tocItems()).includes('Leaving soon'));
});
await step('it is saved, survives a reload, and the HTML download has working links', async () => {
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body).includes('tableOfContents'), 10000);
  await page.reload();
  await page.locator('.paper nav.doc-toc li').first().waitFor();
  if ((await tocItems()).join('|') !== 'Welcome|Holidays|Expenses and travel|Leaving soon') throw new Error((await tocItems()).join('|'));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as HTML' }).click()]);
  const html = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  if (!/<a href="#expenses-and-travel">Expenses and travel<\/a>/.test(html)) throw new Error(html.slice(0, 300));
  if (!/<h2[^>]* id="expenses-and-travel"/.test(html)) throw new Error('heading id');
  const word = await page.request.get(`${B}/api/files/${docId}/export`);
  if (word.status() !== 200) throw new Error('word ' + word.status());
});
await step('it can be deleted like any block', async () => {
  await page.locator('.paper nav.doc-toc .doc-toc-title').click();
  await page.keyboard.press('Delete');
  await until(async () => (await page.locator('.paper nav.doc-toc').count()) === 0);
  await page.keyboard.press('Control+z');
  await page.locator('.paper nav.doc-toc').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
