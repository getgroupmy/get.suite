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
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
let docId, kim;
const content = async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content);
const visible = (p, sel) => p.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
const selectText = (p, word) => p.evaluate((w) => {
  const walk = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const i = n.data.indexOf(w);
    if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
  }
  return false;
}, word);
await step('setup: a long document with headings and a bookmark', async () => {
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
  const filler = Array.from({ length: 50 }, (_, i) => para(`Filler paragraph number ${i + 1}.`));
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Handbook', content: { type: 'doc', content: [
    para('Please see terms below.'), para('Last line at the top.'), ...filler,
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Payment Terms' }] }, para('Pay within thirty days.'),
    { type: 'paragraph', content: [{ type: 'bookmark', attrs: { id: 'appx1234' } }, { type: 'text', text: 'Appendix starts here.' }] }, ...filler,
  ] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Please see terms below.').waitFor();
});
await step('Ctrl+K on selected words: pick a heading from the list', async () => {
  await page.getByText('Please see terms below.').click();
  await selectText(page, 'terms');
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Insert link' });
  const list = dlg.getByRole('list', { name: 'Headings and bookmarks' });
  await list.getByRole('button', { name: 'Heading: Payment Terms' }).waitFor();
  await list.getByRole('button', { name: 'Bookmark: Appendix starts here.' }).waitFor();
  if (await dlg.getByLabel('Text', { exact: true }).count()) throw new Error('words were selected: no Text box');
  await dlg.getByLabel('Address').fill('appendix');
  await until(async () => (await list.getByRole('button').count()) === 1);
  await dlg.getByLabel('Address').fill('pay');
  await list.getByRole('button', { name: 'Heading: Payment Terms' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await content()).includes('"text":"terms","marks":[{"type":"link","attrs":{"href":"#payment-terms"'));
});
await step('Ctrl+click the link goes to the heading', async () => {
  if (await visible(page, 'h2')) throw new Error('heading already in view');
  await page.locator('.ProseMirror a', { hasText: 'terms' }).click({ modifiers: ['Control'] });
  await until(() => visible(page, 'h2'));
});
await step('With nothing selected: text and a typed address; bad ones are refused', async () => {
  await page.getByText('Last line at the top.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Read ');
  await page.getByRole('button', { name: 'Link (Ctrl+K)' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert link' });
  await dlg.getByLabel('Text', { exact: true }).fill('our site');
  await dlg.getByLabel('Address').fill('hello');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await dlg.getByRole('alert').getByText('That isn’t a web or email address').waitFor();
  await dlg.getByLabel('Address').fill('example.com/help');
  await dlg.getByLabel('Address').press('Enter');
  await dlg.waitFor({ state: 'detached' });
  await until(async () => (await content()).includes('"text":"our site","marks":[{"type":"link","attrs":{"href":"https://example.com/help"'));
  await page.keyboard.type('today.');
  await until(async () => (await page.locator('.ProseMirror p', { hasText: 'Last line' }).innerText()) === 'Last line at the top. Read our site today.');
  await until(async () => (await content()).includes('"text":" today."}'));
  if ((await content()).includes('"text":" today.","marks"')) throw new Error('typing after went on the link');
});
await step('Edit and remove a link', async () => {
  await page.locator('.ProseMirror a', { hasText: 'our site' }).click();
  await page.keyboard.press('Control+k');
  const dlg = page.getByRole('dialog', { name: 'Edit link' });
  if ((await dlg.getByLabel('Address').inputValue()) !== 'https://example.com/help') throw new Error('not filled in');
  await dlg.getByRole('button', { name: 'Bookmark: Appendix starts here.' }).click();
  await until(async () => (await content()).includes('"text":"our site","marks":[{"type":"link","attrs":{"href":"#bm-appx1234"'));
  await page.locator('.ProseMirror a', { hasText: 'our site' }).click();
  await page.getByRole('button', { name: 'Link (Ctrl+K)' }).click();
  await page.getByRole('dialog', { name: 'Edit link' }).getByRole('button', { name: 'Remove link' }).click();
  await until(async () => !(await content()).includes('#bm-appx1234'));
});
await step('A reader clicks a link to a heading and lands there', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${docId}`);
  await kim.locator('.ProseMirror a', { hasText: 'terms' }).waitFor();
  await kim.locator('.ProseMirror a', { hasText: 'terms' }).click();
  await until(() => visible(kim, 'h2'));
  if (!kim.url().endsWith('#payment-terms')) throw new Error(kim.url());
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
