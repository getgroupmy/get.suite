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
const bg = (p, k) => cell(p, k).evaluate((el) => getComputedStyle(el).backgroundColor);
const content = async () => (await api(page, 'GET', `/files/${sheetId}/content`)).body.content.sheets[0];
await step('Alternating colours from the right-click menu: heading and stripes, for everyone', async () => {
  await cell(page, 'B3').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Alternating colours…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alternating colours' });
  if ((await dlg.getByLabel('Apply to range').inputValue()) !== 'A1:C5') throw new Error(await dlg.getByLabel('Apply to range').inputValue());
  await dlg.getByRole('radio', { name: 'Green' }).click();
  await page.screenshot({ path: `${SP}/shots/bands-dialog.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await bg(page, 'A1')) === 'rgb(52, 168, 83)');
  await until(async () => (await bg(kim, 'B3')) === 'rgb(230, 244, 234)');
  if ((await bg(page, 'B2')) !== 'rgb(255, 255, 255)') throw new Error('odd row ' + await bg(page, 'B2'));
  if ((await bg(page, 'D3')) === 'rgb(230, 244, 234)') throw new Error('outside the range');
  await until(async () => (await content()).bands?.[0]?.range === 'A1:C5');
  await page.screenshot({ path: `${SP}/shots/bands.png` });
});
await step('a row inserted inside grows the band and the stripes carry on', async () => {
  await page.locator('.grid-wrap tbody tr > th', { hasText: /^3$/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '1 row above' }).first().click().catch(async () => { await page.getByRole('menuitem', { name: /Insert 1 row above/ }).click(); });
  await until(async () => (await content()).bands?.[0]?.range === 'A1:C6');
  await until(async () => (await bg(page, 'A4')) === 'rgb(255, 255, 255)');
});
await step('custom colours, a footer, and own fill wins', async () => {
  await cell(page, 'A2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Alternating colours…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Alternating colours' });
  if ((await dlg.getByLabel('Apply to range').inputValue()) !== 'A1:C6') throw new Error('edits the existing one');
  await dlg.getByLabel('Footer row').check();
  await dlg.getByLabel('Colour 2 colour').fill('#ffeeaa');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await bg(page, 'A3')) === 'rgb(255, 238, 170)');
  await until(async () => (await content()).bands?.[0]?.footer === true);
  if ((await bg(page, 'A6')) !== 'rgb(198, 233, 200)' && (await bg(page, 'A6')) === 'rgb(255, 255, 255)') throw new Error('footer ' + await bg(page, 'A6'));
});
await step('Remove alternating colours', async () => {
  await cell(page, 'A2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Alternating colours…' }).click();
  await page.getByRole('dialog', { name: 'Alternating colours' }).getByRole('button', { name: 'Remove alternating colours' }).click();
  await until(async () => !(await content()).bands);
  await until(async () => (await bg(kim, 'A1')) !== 'rgb(52, 168, 83)');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
