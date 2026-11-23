import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;

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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Apple pie', A2: 'apple', A3: 'pear', B1: '12', B2: '=B1*10', B3: '=A2&" tart"', C1: 'Pineapple' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});

const bar = page.getByRole('search', { name: 'Find in sheet' });
const count = () => bar.locator('.find-count').innerText();


await step('on a phone the Find bar keeps its tick boxes behind Options, and stays short', async () => {
  const s3 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Year', content: { sheets: [
    { name: 'Jan', cells: { A1: 'Rent', A2: 'Power', A3: 'rent' } }, { name: 'February figures', cells: { A1: 'Power', B3: 'Rent' } } ] } })).body;
  await page.goto(`${B}/sheets/${s3.id}`);
  await cell('A2').click();
  await page.keyboard.press('Control+f');
  await bar.getByLabel('Find', { exact: true }).fill('rent');
  await bar.getByRole('group', { name: 'Also found in other sheets' }).waitFor();
  const height = () => page.evaluate(() => document.querySelector('.find-bar').getBoundingClientRect().height);
  if (await bar.getByLabel('Match case').isVisible()) throw new Error('the tick boxes should be folded away');
  const closed = await height();
  if (closed > 150) throw new Error(`the bar is ${closed}px tall`);
  await page.screenshot({ path: `${SP}/shots/phonefind.png` });
  await bar.getByRole('button', { name: /^Options/ }).click();
  await bar.getByLabel('Match case').check();
  if (await bar.locator('.find-count').innerText() !== '1 of 1') throw new Error('Match case did not narrow it');
  // a ticked box keeps them in view (and says how many are on)
  await bar.getByRole('button', { name: 'Options (1)' }).waitFor();
  if (!(await bar.getByLabel('Whole cell').isVisible())) throw new Error('ticked options stay in view');
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth }));
  if (m.doc > m.vw) throw new Error('the page scrolls sideways');
  await page.keyboard.press('Escape');
});
await step('Docs and Slides fold their Find tick boxes the same way on a phone', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lease', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rent and rent again' }] }] } })).body;
  await page.goto(`${B}/docs/${d.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+f');
  const docBar = page.getByRole('search').filter({ has: page.getByPlaceholder('Find in document') });
  await docBar.getByPlaceholder('Find in document').fill('rent');
  if (await docBar.getByLabel('Match case').isVisible()) throw new Error('Docs: the tick boxes should be folded away');
  const h = await docBar.evaluate((el) => el.getBoundingClientRect().height);
  if (h > 120) throw new Error(`Docs: the bar is ${h}px tall`);
  await docBar.getByRole('button', { name: /^Options/ }).click();
  await docBar.getByLabel('Match case').check();
  await docBar.getByRole('button', { name: 'Options (1)' }).waitFor();
  await docBar.getByText('1 of 1').waitFor();
  await page.keyboard.press('Escape');
  const p = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Deck' })).body;
  await page.goto(`${B}/slides/${p.id}`);
  await page.getByText('Slide 1 of 1').waitFor();
  await page.keyboard.press('Control+f');
  const slideBar = page.getByRole('search').filter({ has: page.getByPlaceholder('Find in presentation') });
  await slideBar.getByPlaceholder('Find in presentation').waitFor();
  if (await slideBar.getByLabel('Whole words').isVisible()) throw new Error('Slides: the tick boxes should be folded away');
  await slideBar.getByRole('button', { name: /^Options/ }).click();
  await slideBar.getByLabel('Whole words').check();
  await slideBar.getByRole('button', { name: 'Options (1)' }).waitFor();
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
