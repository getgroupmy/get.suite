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
const bg = (p) => p.locator('.paper').evaluate((el) => getComputedStyle(el).backgroundImage);
await step('Page setup → Watermark puts DRAFT faintly across the page; the other editor sees it at once', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await dlg.getByLabel('Watermark (faint, across every page)').fill('DRAFT');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).waitFor();
  await until(async () => /svg/.test(await bg(page)) && decodeURIComponent(await bg(page)).includes('>DRAFT</text>'));
  await until(async () => decodeURIComponent(await bg(kim)).includes('>DRAFT</text>'));
  await page.screenshot({ path: `${SP}/shots/watermark.png` });
});
await step('printing puts it on every page', async () => {
  await page.emulateMedia({ media: 'print' });
  const shown = await page.locator('.print-watermark').evaluate((el) => { const s = getComputedStyle(el); return `${s.display} ${s.position} ${/svg/.test(s.backgroundImage)}`; });
  if (shown !== 'block fixed true') throw new Error(shown);
  await page.emulateMedia({ media: 'screen' });
  if (await page.locator('.print-watermark').isVisible()) throw new Error('shown on screen as well as the paper background');
});
await step('the Word download has a Word watermark; opening that file keeps it', async () => {
  const back = await page.evaluate(async (id) => {
    const buf = await (await fetch(`/api/files/${id}/export`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Report%20copy.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: buf })).json();
    const opened = await (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
    return opened.id;
  }, docId);
  await page.goto(`${B}/docs/${back}`);
  await page.getByText('Quarterly figures').waitFor();
  await until(async () => decodeURIComponent(await bg(page)).includes('>DRAFT</text>'));
});
await step('clearing it takes it off', async () => {
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Quarterly figures').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await dlg.getByLabel('Watermark (faint, across every page)').fill('');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => !/svg/.test(await bg(page)));
  await until(async () => !/svg/.test(await bg(kim)));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
await browser.close();
process.exit(failed ? 1 : 0);
