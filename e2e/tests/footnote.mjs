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
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [p('Sales grew this quarter.'), p('Costs fell after the move.')] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const pg of [page, kim]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('Costs fell after the move.').waitFor(); }
});
const textOnly = (p = page) => p.evaluate(() => { const c = document.querySelector('.paper .tiptap').cloneNode(true); c.querySelectorAll('.collaboration-carets__caret').forEach((x) => x.remove()); return c.textContent; });
const refs = (p = page) => p.locator('.paper sup[data-footnote]');
const number = (loc) => loc.evaluate((el) => getComputedStyle(el, '::after').content);
await step('Footnote puts a numbered marker at the cursor and the cursor in its note', async () => {
  await page.getByText('Costs fell after the move.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Insert footnote' }).click();
  await until(async () => (await refs().count()) === 1);
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Footnote 1'));
  await page.keyboard.type('Moved to the cheaper warehouse in May');
  await page.keyboard.press('Enter'); // back to the text
  await page.keyboard.type(' Really.');
  await until(async () => (await textOnly()).includes('Costs fell after the move. Really.')).catch(async (e) => { console.log('DBG', JSON.stringify(await textOnly()), await page.locator('.footnote-input').first().inputValue(), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))); throw e; });
});
await step('an earlier footnote becomes 1, the other renumbers; Kim sees both live', async () => {
  await page.getByText('Sales grew this quarter.').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Insert footnote' }).click();
  await until(async () => (await refs().count()) === 2);
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Footnote 1'));
  await page.keyboard.type('Source: Q3 report');
  if ((await refs().nth(0).getAttribute('title')) !== 'Source: Q3 report') throw new Error('order: ' + await refs().nth(0).getAttribute('title'));
  const notes = page.getByRole('region', { name: 'Footnotes' });
  if ((await notes.getByLabel('Footnote 1').inputValue()) !== 'Source: Q3 report') throw new Error('first note');
  if ((await notes.getByLabel('Footnote 2').inputValue()) !== 'Moved to the cheaper warehouse in May') throw new Error('second note');
  await until(async () => (await kim.getByRole('region', { name: 'Footnotes' }).getByLabel('Footnote 1').inputValue().catch(() => '')) === 'Source: Q3 report');
  await page.screenshot({ path: `${SP}/shots/footnotes.png` });
});
await step('Kim clicks a number in the text and lands in its note; changes it', async () => {
  await refs(kim).nth(1).click();
  await until(async () => kim.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Footnote 2'));
  await kim.keyboard.press('End');
  await kim.keyboard.type(' 2026');
  await until(async () => (await page.getByRole('region', { name: 'Footnotes' }).getByLabel('Footnote 2').inputValue()) === 'Moved to the cheaper warehouse in May 2026');
});
await step('saved; printing shows the notes as text; Word has real footnotes', async () => {
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body).includes('May 2026'), 10000);
  await page.emulateMedia({ media: 'print' });
  const shown = await page.locator('.footnote-print').first().evaluate((el) => getComputedStyle(el).display);
  const box = await page.locator('.footnote-input').first().evaluate((el) => getComputedStyle(el).display);
  await page.emulateMedia({ media: 'screen' });
  if (shown === 'none' || box !== 'none') throw new Error(`print ${shown} ${box}`);
  const r = await page.request.get(`${B}/api/files/${docId}/export`);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(await r.body());
  const fx = await zip.file('word/footnotes.xml').async('string');
  if (!fx.includes('Source: Q3 report') || !fx.includes('May 2026')) throw new Error('footnotes.xml');
});
await step('deleting the marker removes its note', async () => {
  await refs().nth(0).click();
  await page.locator('.paper .tiptap').focus();
  await refs().nth(0).click();
  await page.keyboard.press('Escape');
  await page.getByText('Sales grew this quarter.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await until(async () => (await refs().count()) === 1);
  if ((await page.getByRole('region', { name: 'Footnotes' }).getByLabel('Footnote 1').inputValue()) !== 'Moved to the cheaper warehouse in May 2026') throw new Error('renumbered');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
