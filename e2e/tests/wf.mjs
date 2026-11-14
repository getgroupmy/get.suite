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
let sheetId;
const cell = (k) => page.locator(`[data-k="${k}"]`);
const typeIn = async (k, text) => { await cell(k).click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
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
  const cells = { A1: 'Step', B1: 'Cash', A2: 'Start', B2: '100', A3: 'Sales', B3: '50', A4: 'Costs', B4: '-80', A5: 'Tax', B5: '-20', E1: 'Height', E2: '151', E3: '158', E4: '162', E5: '175', E6: '188', E7: '166', E8: '170' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('E8').getByText('170').waitFor();
});
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
const insert = async (range, label, title) => {
  await page.getByRole('button', { name: 'Insert chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert chart' });
  await dlg.getByLabel('Cells').fill(range);
  await dlg.locator('.chart-types label', { hasText: new RegExp(`^${label}$`) }).click();
  await dlg.getByLabel('Title').fill(title);
  return dlg;
};
const biggest = async (sel) => { const n = await page.locator(sel).count(); let best = 0, area = 0; for (let k = 0; k < n; k++) { const b = await page.locator(sel).nth(k).boundingBox(); if (b && b.width * b.height > area) { area = b.width * b.height; best = k; } } return page.locator(sel).nth(best); };
await step('a waterfall adds the steps up, with a total', async () => {
  await cell('G2').click();
  const dlg = await insert('A1:B5', 'Waterfall', 'Cash this month');
  await dlg.getByRole('button', { name: 'Insert' }).click();
  const chart = page.getByRole('region', { name: 'Chart: Cash this month' });
  await chart.waitFor();
  await chart.getByText('Increase').waitFor();
  await chart.getByText('Decrease').waitFor();
  // Five bars (four steps and the total): hovering Costs shows the change and where it leaves the total.
  const bars = chart.locator('svg rect[fill^="var(--series"]');
  await until(async () => (await bars.count()) === 5);
  await bars.nth(2).hover({ force: true });
  await chart.getByText('Running total: 70').waitFor();
  await chart.getByText('−80').waitFor();
  await page.screenshot({ path: `${SP}/shots/waterfall.png` });
});
await step('a histogram counts the heights into ranges', async () => {
  await cell('G20').click();
  const dlg = await insert('E1:E8', 'Histogram', 'Heights');
  await dlg.getByRole('button', { name: 'Insert' }).click();
  const chart = page.getByRole('region', { name: 'Chart: Heights' });
  await chart.waitFor();
  await chart.getByRole('button', { name: 'Show data' }).click();
  await chart.getByText('160–180').waitFor();
  const counts = await chart.locator('tbody td').allInnerTexts();
  if (counts.join(',') !== '2,4,1') throw new Error(counts.join(','));
  await chart.getByRole('button', { name: 'Show chart' }).click();
});
await step('both go into the Excel download as columns', async () => {
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  const file = `${SP}/wf-dl.xlsx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(file));
  const all = (await Promise.all(Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).map((f) => zip.file(f).async('string')))).join('');
  if (!/<c:v>Base<\/c:v><\/c:tx><c:spPr><a:noFill\/>/.test(all) || !/<c:v>160–180<\/c:v>/.test(all)) throw new Error(all.slice(0, 600));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
