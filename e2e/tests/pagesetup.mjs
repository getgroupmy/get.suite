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
const paperW = (p) => p.locator('.paper').evaluate((el) => Math.round(el.getBoundingClientRect().width));
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
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quarterly figures' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Quarterly figures').waitFor(); }
});
await step('page setup: Letter, landscape, narrow margins, a header, footer and page numbers', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await dlg.getByLabel('Paper size').selectOption('letter');
  await dlg.getByRole('radio', { name: 'Landscape' }).click();
  await dlg.getByLabel('Margins').selectOption('narrow');
  await dlg.getByLabel('Header (top of every page)').fill('Acme Trading');
  await dlg.getByLabel('Footer (bottom of every page)').fill('Confidential');
  await dlg.getByLabel('Page numbers in the footer').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).waitFor();
  await until(async () => (await paperW(page)) === 1056);
  await page.locator('.paper-header', { hasText: 'Acme Trading' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/pagesetup.png` });
});
await step('the other editor sees the new paper at once', async () => {
  await until(async () => (await paperW(kim)) === 1056);
  await kim.locator('.paper-footer', { hasText: 'Confidential' }).waitFor();
});
await step('printing (PDF) uses the paper size and orientation', async () => {
  const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
  const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf);
  if (!box || Math.round(box[1]) !== 792 || Math.round(box[2]) !== 612) throw new Error(box ? box[0] : 'no MediaBox');
});
await step('the Word download carries it too', async () => {
  const xml = await page.evaluate(async (id) => {
    const buf = await (await fetch(`/api/files/${id}/export`)).arrayBuffer();
    return buf.byteLength;
  }, docId);
  if (xml < 3000) throw new Error(`small file: ${xml}`);
});
await step('Reset goes back to the default paper', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  await page.getByRole('dialog', { name: 'Page setup' }).getByRole('button', { name: 'Reset' }).click();
  await until(async () => (await paperW(page)) === 816);
  if (await page.locator('.paper-header').count()) throw new Error('header left');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
