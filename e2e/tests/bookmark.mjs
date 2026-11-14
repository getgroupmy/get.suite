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
let docId, kim, link;
const content = async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content);
const inView = (p) => p.locator('.doc-bookmark').first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top <= window.innerHeight; });
await step('setup: a long document shared with a viewer', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
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
  const filler = Array.from({ length: 60 }, (_, i) => para(`Filler paragraph number ${i + 1}.`));
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract', content: { type: 'doc', content: [para('Introduction'), ...filler, para('Payment terms: thirty days.'), ...filler] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Payment terms: thirty days.').waitFor();
});
await step('Add a bookmark where the cursor is: its link is copied', async () => {
  await page.getByText('Payment terms: thirty days.').click();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
  const dlg = page.getByRole('dialog', { name: 'Bookmarks' });
  await dlg.getByText('No bookmarks yet.').waitFor();
  await dlg.getByRole('button', { name: '+ Add a bookmark where the cursor is' }).click();
  await page.locator('.toast', { hasText: 'Bookmark added: link copied' }).last().waitFor();
  const list = dlg.getByRole('list', { name: 'Bookmarks in this document' });
  await list.getByText('🔖 Payment terms: thirty days.').waitFor();
  link = await page.evaluate(() => navigator.clipboard.readText());
  if (!new RegExp(`/docs/${docId}#bm-[a-z0-9]{8,16}$`).test(link)) throw new Error(link);
  await until(async () => (await content()).includes(`"type":"bookmark","attrs":{"id":"${link.split('#bm-')[1]}"}`));
  await dlg.getByRole('button', { name: 'Done' }).click();
  if ((await page.locator('.ProseMirror .doc-bookmark').count()) !== 1) throw new Error('marker');
  const text = await page.locator('.ProseMirror p', { hasText: 'Payment terms' }).innerText();
  if (text.trim() !== 'Payment terms: thirty days.') throw new Error('the text changed: ' + text);
});
await step('The link opens the document at the bookmark, for someone else too', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(link);
  await kim.getByText('Payment terms: thirty days.').waitFor();
  await until(() => inView(kim));
  const top = await kim.evaluate(() => document.scrollingElement.scrollTop + (document.querySelector('.editor-scroll, .doc-scroll')?.scrollTop || 0));
  await kim.getByRole('button', { name: 'More', exact: true }).click();
  await kim.getByRole('menuitem', { name: 'Bookmarks' }).click();
  const dlg = kim.getByRole('dialog', { name: 'Bookmarks' });
  await dlg.getByText('🔖 Payment terms: thirty days.').waitFor();
  if (await dlg.getByRole('button', { name: /Add a bookmark|Remove/ }).count()) throw new Error('viewers cannot change bookmarks');
  await dlg.getByRole('button', { name: 'Close' }).click();
});
await step('Go to from the list, and a link to it within the document', async () => {
  await page.getByText('Introduction').click();
  await page.keyboard.press('Control+Home');
  await until(async () => !(await inView(page)));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
  await page.getByRole('dialog', { name: 'Bookmarks' }).getByRole('button', { name: 'Go to bookmark 1' }).click();
  await until(() => inView(page));
  // a link to it from the top of the document
  await page.getByText('Introduction').click();
  await until(async () => !(await inView(page)));
  await page.evaluate((href) => { location.hash = new URL(href).hash; }, link);
  await until(() => inView(page));
});
await step('Remove it', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bookmarks' }).click();
  const dlg = page.getByRole('dialog', { name: 'Bookmarks' });
  await dlg.getByRole('button', { name: 'Copy link to bookmark 1' }).click();
  await page.locator('.toast', { hasText: 'Link to the bookmark copied' }).last().waitFor();
  await dlg.getByRole('button', { name: 'Remove bookmark 1' }).click();
  await dlg.getByText('No bookmarks yet.').waitFor();
  await until(async () => !(await content()).includes('"bookmark"'));
  if (!(await content()).includes('Payment terms: thirty days.')) throw new Error('text lost');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
