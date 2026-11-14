import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
});
let form, sheetPage;
await step('Link to Sheets makes a spreadsheet with the responses so far, and opens it', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Lunch order', questions: [{ id: 'food', type: 'short', title: 'Food' }] })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public' });
  await api(page, 'POST', `/public/forms/${form.token}`, { answers: { food: 'Soup' } });
  await page.goto(`${B}/forms/${form.id}?tab=responses`);
  await page.waitForTimeout(3000); console.log("DBG", (await page.locator("main").innerText().catch(()=>"?")).slice(0,600).replace(/\n/g," | "));
  const opened = page.context().waitForEvent("page");
  await page.getByRole('button', { name: 'Link to Sheets' }).click();
  sheetPage = await opened;
  sheetPage.on('pageerror', (e) => errors.push(`sheet: ${e.message}`));
  await sheetPage.locator('.grid td[data-k="B2"]').waitFor();
  await until(async () => (await sheetPage.locator('.grid td[data-k="B2"]').innerText()).trim() === 'Soup');
  await page.getByRole('link', { name: 'Linked spreadsheet' }).waitFor();
});
await step('a new response shows up in the open spreadsheet straight away', async () => {
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(`${B}/f/${form.token}`);
  await ap.getByLabel('Food').fill('Noodles');
  await ap.getByRole('button', { name: /Submit|Send/ }).click();
  await ap.getByText(/recorded/i).waitFor();
  await until(async () => (await sheetPage.locator('.grid td[data-k="B3"]').innerText()).trim() === 'Noodles');
  await anon.close();
}, sheetPage);
await step('Unlink: new responses no longer go there', async () => {
  await page.getByRole('button', { name: 'Unlink' }).click();
  await page.getByRole('button', { name: 'Link to Sheets' }).waitFor();
  await api(page, 'POST', `/public/forms/${form.token}`, { answers: { food: 'Cake' } });
  await page.waitForTimeout(800);
  if ((await sheetPage.locator('.grid td[data-k="B4"]').innerText()).trim()) throw new Error('added after unlinking');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
