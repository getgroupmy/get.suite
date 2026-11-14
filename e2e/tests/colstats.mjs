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
let sheetId, kim;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const shownRows = (p) => p.locator('.grid-wrap tbody tr > th').allInnerTexts().then((l) => l.slice(0, 7).join(','));
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const cells = { A1: 'Job', B1: 'Status', C1: 'Cost', A2: 'Logo', B2: 'Done', C2: '40', A3: 'Site', B3: 'Open', C3: '250', A4: 'Ads', B4: 'Done', C4: '120', A5: 'Flyers', C5: '30' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A5').getByText('Flyers').waitFor(); }
});
await step('Column stats from the column menu: counts and most frequent values', async () => {
  await page.locator('thead th', { hasText: /^B$/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Column stats…' }).click();
  const d = page.getByRole('dialog', { name: 'Column stats' });
  await d.getByText('Column B · Status').waitFor();
  const counts = d.getByRole('definition');
  const txt = (await d.locator('.stats-grid').first().innerText()).replace(/\s+/g, ' ');
  if (!/Filled 3 Empty 1 Different values 2/.test(txt)) throw new Error(txt);
  const freq = await d.getByRole('list', { name: 'Most frequent values' }).innerText();
  if (!/^Done\s+2\s+Open\s+1$/.test(freq.trim())) throw new Error(freq);
  if (await d.getByRole('list', { name: 'Numbers' }).count() || await d.locator('[aria-label="Numbers"]').count()) throw new Error('no numbers in Status');
});
await step('the arrows go to the next column: numbers summed', async () => {
  const d = page.getByRole('dialog', { name: 'Column stats' });
  await d.getByRole('button', { name: 'Next column' }).click();
  await d.getByText('Column C · Cost').waitFor();
  const nums = (await d.locator('[aria-label="Numbers"]').innerText()).replace(/\s+/g, ' ');
  if (!/Sum 440 Average 110 Median 80 Smallest 30 Largest 250 Numbers 4/.test(nums)) throw new Error(nums);
  await page.screenshot({ path: `${SP}/shots/colstats.png` });
  if (!(await d.getByRole('button', { name: 'Next column' }).isDisabled())) throw new Error('last column');
  await d.getByRole('button', { name: 'Done' }).click();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
