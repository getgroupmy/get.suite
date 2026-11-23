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
  await bar.waitFor({ state: 'detached' }); // (closed)
  // (the grid repaints a moment after the bar goes: wait for the highlights to clear rather than look at once)
  await page.locator('.grid td.find-hit, .grid td.find-current').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => { throw new Error('highlights cleared'); });
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

await step('accents don\'t matter in Find unless Match diacritics is ticked', async () => {
  const waitFor = async (fn) => { for (let end = Date.now() + 8000; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
  const s2 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Menu sheet', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Café', A2: 'cafe au lait', A3: 'tea' } }] } })).body;
  await page.goto(`${B}/sheets/${s2.id}`);
  await cell('A3').click();
  await page.keyboard.press('Control+f');
  await bar.getByLabel('Find', { exact: true }).fill('cafe');
  await waitFor(async () => (await count()) === '1 of 2');
  await bar.getByLabel('Match diacritics').check();
  await waitFor(async () => (await count()) === '1 of 1');
  await page.keyboard.press('Escape');
});

await step('Find says which other sheets have it; a click goes on searching there', async () => {
  const waitFor = async (fn) => { for (let end = Date.now() + 8000; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
  const s3 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Year', content: { sheets: [
    { name: 'Jan', cells: { A1: 'Rent', A2: 'Power' } },
    { name: 'Feb', cells: { A1: 'Power', B3: 'Rent', B5: 'rent rebate', C1: '=B3&"!"' } },
    { name: 'Mar', cells: { A1: 'Water' } },
  ] } })).body;
  await page.goto(`${B}/sheets/${s3.id}`);
  await cell('A2').click();
  await page.keyboard.press('Control+f');
  await bar.getByLabel('Find', { exact: true }).fill('rent');
  await waitFor(async () => (await count()) === '1 of 1');
  const also = bar.getByRole('group', { name: 'Also found in other sheets' });
  await also.getByRole('button', { name: 'Feb (2)' }).waitFor();
  if (await also.getByRole('button').count() !== 1) throw new Error('only Feb has it');
  await page.screenshot({ path: `${SP}/shots/sheetfind-elsewhere.png` });
  await also.getByRole('button', { name: 'Feb (2)' }).click();
  // On Feb the search carries on: its three cells showing it (the formula's result too), the first one selected.
  await waitFor(async () => (await count()) === '1 of 3');
  if (await bar.getByLabel('Find', { exact: true }).inputValue() !== 'rent') throw new Error('the search was lost');
  await bar.getByRole('group', { name: 'Also found in other sheets' }).getByRole('button', { name: 'Jan (1)' }).waitFor();
  await cell('B3').getByText('Rent', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
});

await step('going on in another sheet keeps the tick boxes and what to replace with', async () => {
  const waitFor = async (fn) => { for (let end = Date.now() + 8000; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
  await page.locator('.sheet-tabs, [role=tablist]').getByText('Jan', { exact: true }).first().click();
  await cell('A2').click();
  await page.keyboard.press('Control+h');
  await bar.getByLabel('Find', { exact: true }).fill('rent');
  await bar.getByLabel('Whole cell').check();
  await bar.getByLabel('Replace with').fill('Lease');
  const also = bar.getByRole('group', { name: 'Also found in other sheets' });
  await also.getByRole('button', { name: 'Feb (1)' }).click(); // "rent rebate" is no whole cell
  await waitFor(async () => (await count()) === '1 of 1');
  if (!(await bar.getByLabel('Whole cell').isChecked())) throw new Error('Whole cell was unticked');
  if (await bar.getByLabel('Replace with').inputValue() !== 'Lease') throw new Error('the replacement was lost');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await cell('B3').getByText('Lease', { exact: true }).waitFor();
  await cell('B5').getByText('rent rebate').waitFor();
  await page.keyboard.press('Escape');
});

await step('Regular expression: finds a pattern, replaces with its groups, and says when it cannot be read', async () => {
  const waitFor = async (fn) => { for (let end = Date.now() + 8000; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
  const s4 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Invoices', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'INV-2024-07', A2: 'INV-2025-11', A3: 'Invoice (draft)' } }] } })).body;
  await page.goto(`${B}/sheets/${s4.id}`);
  await cell('A3').click();
  await page.keyboard.press('Control+h');
  await bar.getByLabel('Find', { exact: true }).fill('(\\d{4})-(\\d{2})');
  await waitFor(async () => (await count()) === 'No results'); // as plain text it is nowhere
  await bar.getByLabel('Regular expression').check();
  await waitFor(async () => (await count()) === '1 of 2');
  await bar.getByLabel('Replace with').fill('$2/$1');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await cell('A1').getByText('INV-07/2024', { exact: true }).waitFor();
  await cell('A2').getByText('INV-11/2025', { exact: true }).waitFor();
  await bar.getByLabel('Find', { exact: true }).fill('(draft');
  await waitFor(async () => /valid regular expression/.test(await count()));
  await bar.getByLabel('Regular expression').uncheck();
  await waitFor(async () => (await count()) === '1 of 1');
  await page.keyboard.press('Escape');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
