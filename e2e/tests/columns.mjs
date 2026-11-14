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
  if ((await colCount(page)) !== 'auto') throw new Error('columns at first: ' + await colCount(page));
});
await step('Page setup → Columns: Two, for everyone', async () => {
  await setup(async (dlg) => {
    if ((await dlg.getByRole('radio', { name: 'One' }).getAttribute('aria-checked')) !== 'true') throw new Error('One first');
    await dlg.getByRole('radio', { name: 'Two' }).click();
  });
  await until(async () => (await colCount(page)) === '2');
  await until(async () => (await colCount(kim)) === '2');
  if (!((await xOf(page, 'Last story ends here.')) > (await xOf(page, 'First story starts here.')) + 200)) throw new Error('the last story is not in the second column');
  if ((await api(page, 'GET', `/files/${docId}`)).body.page_setup.columns !== 2) throw new Error('not saved');
  await page.screenshot({ path: `${SP}/shots/columns.png` });
});
await step('Printed in columns too; one column on a phone', async () => {
  await page.emulateMedia({ media: 'print' });
  if ((await colCount(page)) !== '2') throw new Error('print: ' + await colCount(page));
  await page.emulateMedia({ media: 'screen' });
  await kim.setViewportSize({ width: 400, height: 800 });
  await until(async () => (await colCount(kim)) === '1');
  await kim.setViewportSize({ width: 1280, height: 900 });
});
await step('Three, then back to one', async () => {
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'Three' }).click(); });
  await until(async () => (await colCount(kim)) === '3');
  await setup(async (dlg) => {
    if ((await dlg.getByRole('radio', { name: 'Three' }).getAttribute('aria-checked')) !== 'true') throw new Error('Three shown as chosen');
    await dlg.getByRole('radio', { name: 'One' }).click();
  });
  await until(async () => (await colCount(page)) === 'auto');
  await until(async () => (await colCount(kim)) === 'auto');
  if ((await api(page, 'GET', `/files/${docId}`)).body.page_setup.columns !== undefined) throw new Error('one column is the default');
});
await step('The Word download is in columns', async () => {
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'Two' }).click(); });
  const b64 = await page.evaluate(async (id) => {
    const buf = new Uint8Array(await (await fetch(`/api/files/${id}/export`)).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, docId);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('word/document.xml').async('string');
  if (!/<w:cols [^>]*w:num="2"/.test(xml)) throw new Error('no columns in the Word file');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
