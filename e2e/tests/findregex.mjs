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
let docId;
const text = () => page.locator('.ProseMirror').innerText();
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
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Paid on 2026-11-09 and ' }, { type: 'text', text: '2026-12-01', marks: [{ type: 'bold' }] }, { type: 'text', text: '.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ref INV-2041, INV-17.' }] },
  ] };
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Payments', content })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await page.locator('.ProseMirror').getByText('Paid on').waitFor();
});
await step('Regular expression finds a pattern; a bad one says so', async () => {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+h');
  const bar = page.getByRole('search', { name: 'Find in document' });
  await bar.getByLabel('Regular expression').check();
  await bar.getByLabel('Find', { exact: true }).fill('INV-(');
  await bar.getByText('That isn’t a valid regular expression').waitFor();
  await bar.getByLabel('Find', { exact: true }).fill('INV-\\d+');
  await bar.getByText('1 of 2').waitFor();
});
await step('Replace all with groups reorders dates, keeping bold', async () => {
  const bar = page.getByRole('search', { name: 'Find in document' });
  await bar.getByLabel('Find', { exact: true }).fill('(\\d{4})-(\\d{2})-(\\d{2})');
  await bar.getByText('1 of 2').waitFor();
  await bar.getByLabel('Replace with').fill('$3/$2/$1');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await until(async () => (await text()).includes('Paid on 09/11/2026 and 01/12/2026.'));
  if ((await page.locator('.ProseMirror strong').innerText()) !== '01/12/2026') throw new Error('bold kept');
  await page.screenshot({ path: `${SP}/shots/findregex.png` });
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content).includes('09/11/2026'));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
