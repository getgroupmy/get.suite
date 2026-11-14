import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let deckId;
const content = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content;
// The server stores co-edited changes a couple of seconds after the last one.
const saved = async () => { await page.getByText('All changes saved').waitFor({ timeout: 10000 }); await page.waitForTimeout(2600); };
const stage = () => page.locator('.slide-stage > .slide');
const itemBox = async (label) => page.locator(`.slide-stage [aria-label^="${label}"]`).first().boundingBox();

await step('setup and a new presentation from Drive', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(B + '/drive');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await page.waitForURL(/\/slides\//);
  deckId = page.url().split('/').pop();
  await page.getByText('Click to add title').waitFor();
});

const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const tableNow = async () => (await content()).slides[0].items.find((i) => i.type === 'table');
await step('Table puts a 3×3 table with a heading row on the slide', async () => {
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const t = page.locator('.slide-stage .slide-table');
  await t.waitFor();
  if ((await t.locator('tr').count()) !== 3 || (await t.locator('tr').first().locator('th').count()) !== 3) throw new Error('3×3 with headings');
});
await step('double-click to type in the cells; it saves', async () => {
  await page.locator('.slide-stage [aria-label="Table"]').dblclick();
  await page.getByLabel('Row 1, column 1').fill('Region');
  await page.getByLabel('Row 1, column 2').fill('Sales');
  await page.getByLabel('Row 2, column 1').fill('North');
  await page.getByLabel('Row 2, column 2').fill('120');
  await page.keyboard.press('Escape');
  await until(async () => (await tableNow())?.cells?.[1]?.[1] === '120');
  await page.locator('.slide-stage .slide-table th', { hasText: 'Region' }).waitFor();
});
await step('rows and columns: add and take off; heading row off', async () => {
  await page.locator('.slide-stage [aria-label="Table"]').click();
  await page.getByRole('button', { name: 'Add a row' }).click();
  await page.getByRole('button', { name: 'Remove the last column' }).click();
  await until(async () => { const t = await tableNow(); return t.cells.length === 4 && t.cells[0].length === 2 && t.cells[0][0] === 'Region'; });
  await page.getByRole('button', { name: 'Heading row' }).click();
  await until(async () => (await tableNow()).header === false);
  if (await page.locator('.slide-stage .slide-table th').count()) throw new Error('no headings now');
  await page.getByRole('button', { name: 'Heading row' }).click();
  await saved();
  await page.screenshot({ path: `${SP}/shots/slide-table.png` });
});
await step('PowerPoint download has the table', async () => {
  const r = await page.request.get(`${B}/api/files/${deckId}/export`);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(await r.body())).file('ppt/slides/slide1.xml').async('string');
  if (!xml.includes('<a:tbl>') || !xml.includes('Region') || !xml.includes('North')) throw new Error('table in pptx');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
