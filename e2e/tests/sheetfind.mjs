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
await step('Ctrl+F finds cells by what they show and moves between them', async () => {
  await cell('A1').click();
  await page.keyboard.press('Control+f');
  await bar.getByLabel('Find', { exact: true }).fill('apple');
  await page.waitForTimeout(200);
  if ((await count()) !== '1 of 4') throw new Error(await count());
  if (!(await cell('A1').getAttribute('class')).includes('find-current')) throw new Error('A1 current');
  if (!(await cell('B3').getAttribute('class')).includes('find-hit')) throw new Error('B3 hit');
  await bar.getByLabel('Find', { exact: true }).press('Enter');
  if ((await count()) !== '2 of 4') throw new Error(await count());
  if ((await page.locator('.formula-bar .cell-name').inputValue()) !== 'C1') throw new Error('selected C1');
  await bar.getByRole('button', { name: 'Previous match' }).click();
  await bar.getByRole('button', { name: 'Previous match' }).click();
  if ((await count()) !== '4 of 4') throw new Error(await count());
  await bar.getByLabel('Whole cell').check();
  if ((await count()) !== '1 of 1') throw new Error(await count());
  await bar.getByLabel('Whole cell').uncheck();
  await bar.getByLabel('Find', { exact: true }).fill('120');
  if ((await count()) !== '1 of 1') throw new Error('number shown ' + await count());
  await bar.getByLabel('Find', { exact: true }).fill('B1*');
  if ((await count()) !== 'No results') throw new Error(await count());
  await bar.getByLabel('Search formulas').check();
  if ((await count()) !== '1 of 1') throw new Error(await count());
  await page.keyboard.press('Escape');
  if (await bar.count()) throw new Error('closed');
  if (await page.locator('.grid td.find-hit, .grid td.find-current').count()) throw new Error('highlights cleared');
});

await step('Ctrl+H replaces one, then all, leaving formulas alone; undo works', async () => {
  await page.keyboard.press('Control+h');
  await bar.getByLabel('Find', { exact: true }).fill('apple');
  await bar.getByLabel('Replace with').fill('plum');
  await bar.getByRole('button', { name: 'Replace', exact: true }).click();
  if ((await cell('A1').innerText()) !== 'plum pie') throw new Error(await cell('A1').innerText());
  if ((await count()) !== '1 of 3') throw new Error(await count());
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await page.getByText('Replaced in 2 cells; 1 formula cell left alone').waitFor();
  if ((await cell('C1').innerText()) !== 'Pineplum') throw new Error(await cell('C1').innerText());
  if ((await cell('A2').innerText()) !== 'plum') throw new Error(await cell('A2').innerText());
  if ((await cell('B3').innerText()) !== 'plum tart') throw new Error('formula follows its source: ' + await cell('B3').innerText());
  if ((await count()) !== 'No results') throw new Error(await count());
  await bar.getByLabel('Find', { exact: true }).fill('10');
  await bar.getByLabel('Search formulas').check();
  await bar.getByLabel('Replace with').fill('3');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  if ((await cell('B2').innerText()) !== '36') throw new Error(await cell('B2').innerText());
  await page.screenshot({ path: process.argv[2] + '/shots/find.png' });
  await bar.getByRole('button', { name: 'Close find' }).click();
  await page.keyboard.press('Control+z');
  if ((await cell('B2').innerText()) !== '120') throw new Error('undo ' + await cell('B2').innerText());
  await saved();
});

await step('viewers can find but not replace', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await api(page, 'POST', '/users', { local: 'vic', domain: 'acme.com', name: 'Vic Viewer', password: 'password123' });
  const vic = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'vic@acme.com');
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: vic.id, role: 'viewer' }] });
  await p.goto(B);
  await p.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic@acme.com', password: 'password123' }) }));
  await p.goto(`${B}/sheets/${sheet.id}`);
  await p.locator('.grid td[data-k="A1"]').click();
  await p.keyboard.press('Control+h');
  const b = p.getByRole('search', { name: 'Find in sheet' });
  await b.getByLabel('Find', { exact: true }).fill('plum');
  if ((await b.locator('.find-count').innerText()) !== '1 of 4') throw new Error(await b.locator('.find-count').innerText());
  if (await b.getByLabel('Replace with').count()) throw new Error('viewer replace');
  await ctx.close();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
