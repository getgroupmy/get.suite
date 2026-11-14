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
const style = (p, text, prop) => p.locator('.paper .tiptap p', { hasText: text }).first().evaluate((el, pr) => { const span = el.querySelector('span[style*="font"]') || el; return { font: getComputedStyle(span).fontFamily, size: getComputedStyle(span).fontSize, lh: el.style.lineHeight }; }, prop);
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
  const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Styled', content: { type: 'doc', content: [p('Letter to the board'), p('Second paragraph stays as it is')] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const pg of [page, kim]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('Letter to the board').waitFor(); }
});
await step('font and size on selected text; spacing on the paragraph', async () => {
  await page.locator('.paper .tiptap p', { hasText: 'Letter to the board' }).click({ clickCount: 3 });
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => { const e = document.querySelector('.paper .tiptap').editor; return e.state.selection.to - e.state.selection.from; });
  if (sel < 10) throw new Error(`selection ${sel}`);
  await page.getByLabel('Font', { exact: true }).selectOption({ label: 'Georgia' });
  await page.getByLabel('Text size').selectOption('18pt');
  await page.getByLabel('Line spacing').selectOption({ label: '↕ Double' });
  const s = await style(page, 'Letter to the board');
  if (!/Georgia/.test(s.font) || s.size !== '24px' || s.lh !== '2') throw new Error(JSON.stringify(s));
  if ((await page.getByLabel('Font', { exact: true }).inputValue()) !== 'Georgia, serif') throw new Error('menu shows the font');
  await page.screenshot({ path: `${SP}/shots/typography.png` });
});
await step('the other editor sees it; other text is untouched', async () => {
  await until(async () => { const s = await style(kim, 'Letter to the board'); return /Georgia/.test(s.font) && s.size === '24px' && s.lh === '2'; });
  const other = await style(kim, 'Second paragraph');
  if (/Georgia/.test(other.font) || other.lh) throw new Error(JSON.stringify(other));
});
await step('kept after reopening, and in the Word download', async () => {
  await page.waitForTimeout(2500); // saved
  await page.reload();
  await page.getByText('Letter to the board').waitFor();
  const s = await style(page, 'Letter to the board');
  if (!/Georgia/.test(s.font) || s.lh !== '2') throw new Error(JSON.stringify(s));
  const size = await page.evaluate(async (id) => (await (await fetch(`/api/files/${id}/export`)).arrayBuffer()).byteLength, docId);
  if (size < 3000) throw new Error('no Word file');
});
await step('Default puts it back', async () => {
  await page.locator('.paper .tiptap p', { hasText: 'Letter to the board' }).click({ clickCount: 3 });
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => { const e = document.querySelector('.paper .tiptap').editor; return e.state.selection.to - e.state.selection.from; });
  if (sel < 10) throw new Error(`selection ${sel}`);
  await page.getByLabel('Font', { exact: true }).selectOption({ label: 'Default' });
  await page.getByLabel('Line spacing').selectOption({ label: '↕ Spacing' });
  const s = await style(page, 'Letter to the board');
  if (/Georgia/.test(s.font) || s.lh) throw new Error(JSON.stringify(s));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
