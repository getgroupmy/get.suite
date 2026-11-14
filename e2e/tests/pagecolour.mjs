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
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const colCount = (p) => p.locator('.paper .ProseMirror').evaluate((el) => getComputedStyle(el).columnCount);
const xOf = (p, text) => p.locator('.ProseMirror p', { hasText: text }).evaluate((el) => Math.round(el.getBoundingClientRect().left));
const setup = async (fn) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await fn(dlg);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).last().waitFor();
};
await step('setup: a newsletter shared with an editor', async () => {
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
  const body = Array.from({ length: 24 }, (_, i) => para(`Story ${i + 1}: something happened at the office this week and everyone was pleased about it.`));
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Newsletter', content: { type: 'doc', content: [para('First story starts here.'), ...body, para('Last story ends here.')] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Last story ends here.').waitFor(); }
});
const paper = (p) => p.locator('.paper').evaluate((el) => { const s = getComputedStyle(el); return `${s.backgroundColor} ${s.color}`; });
await step('Page setup → Page colour: light yellow, for everyone', async () => {
  await setup(async (dlg) => {
    if ((await dlg.getByRole('radio', { name: 'White' }).getAttribute('aria-checked')) !== 'true') throw new Error('white first');
    await dlg.getByRole('radio', { name: 'Light yellow' }).click();
  });
  await until(async () => (await paper(page)).startsWith('rgb(255, 242, 204)'));
  await until(async () => (await paper(kim)).startsWith('rgb(255, 242, 204)'));
  if ((await api(page, 'GET', `/files/${docId}`)).body.page_setup.pageColor !== '#fff2cc') throw new Error('not saved');
  await page.screenshot({ path: `${SP}/shots/pagecolour.png` });
});
await step('printed in colour; a dark colour gets light text', async () => {
  await page.emulateMedia({ media: 'print' });
  const printed = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ media: 'screen' });
  if (printed !== 'rgb(255, 242, 204)') throw new Error(`printed ${printed}`);
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'Navy' }).click(); });
  await until(async () => (await paper(page)) === 'rgb(11, 37, 69) rgb(232, 234, 237)');
  await page.screenshot({ path: `${SP}/shots/pagecolour-navy.png` });
});
await step('a colour of your own, then back to white', async () => {
  await setup(async (dlg) => { await dlg.getByLabel('Another page colour').fill('#e6f4ea'); });
  await until(async () => (await paper(page)).startsWith('rgb(230, 244, 234)'));
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'White' }).click(); });
  await until(async () => (await api(page, 'GET', `/files/${docId}`)).body.page_setup.pageColor === undefined);
  if ((await paper(page)).startsWith('rgb(230, 244, 234)')) throw new Error('still green');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
