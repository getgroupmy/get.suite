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
await step('search in Drive finds a document by the words inside it, with where it matched', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board minutes', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The board approved the new Penang warehouse lease for three years.' }] }] } });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Penang trip', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Packing list' }] }] } });
  await page.waitForTimeout(2500); // the index catches up
  await page.getByLabel('Search everything').fill('penang');
  await page.getByLabel('Search everything').press('Enter');
  const rows = page.locator('.files tbody tr');
  await rows.filter({ hasText: 'Board minutes' }).waitFor();
  // (results come in as they're found: wait for the list to settle with the name match on top)
  for (let end = Date.now() + 8000; !(await rows.first().textContent()).includes('Penang trip'); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('the name match should come first');
  await rows.filter({ hasText: 'Board minutes' }).locator('mark', { hasText: 'Penang' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/search.png` });
  await rows.filter({ hasText: 'Board minutes' }).locator('td.name').dblclick();
  await page.getByText('The board approved').waitFor();
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
