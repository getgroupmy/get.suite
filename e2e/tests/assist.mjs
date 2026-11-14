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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Funcs', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'apple', A2: 'pear', B1: '10', B2: '20' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});

await step('typing a name suggests functions; arrows and Tab pick one', async () => {
  await cell('C1').click();
  await page.keyboard.type('=coun');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  await page.screenshot({ path: process.argv[2] + '/shots/list.png' });
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (names.join(',') !== 'COUNT,COUNTA,COUNTIF,COUNTIFS,COUNTBLANK,COUNTUNIQUE,COUNTUNIQUEIFS') throw new Error(names.join(','));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  if ((await page.getByLabel('Edit C1').inputValue()) !== '=COUNTIF(') throw new Error(await page.getByLabel('Edit C1').inputValue());
  if (await list.count()) throw new Error('list should close');
  const help = page.getByRole('status', { name: 'Function help' });
  if ((await help.locator('b').innerText()) !== 'range') throw new Error('first argument bold');
  await page.keyboard.type('A1:A2, ');
  if ((await help.locator('b').innerText()) !== 'criterion') throw new Error('second argument bold');
  await page.screenshot({ path: process.argv[2] + '/shots/sig.png' });
  if (!(await help.innerText()).includes('How many cells match')) throw new Error(await help.innerText());
  await page.keyboard.type('"pear")');
  await page.keyboard.press('Enter');
  if ((await cell('C1').innerText()) !== '1') throw new Error(await cell('C1').innerText());
});

await step('Enter picks a suggestion, Escape hides the list, clicking one works in the formula bar', async () => {
  await cell('C2').click();
  await page.keyboard.type('=xlo');
  await page.keyboard.press('Enter');
  if ((await page.getByLabel('Edit C2').inputValue()) !== '=XLOOKUP(') throw new Error(await page.getByLabel('Edit C2').inputValue());
  await page.keyboard.type('"apple", A1:A2, B1:B2)');
  await page.keyboard.press('Enter');
  if ((await cell('C2').innerText()) !== '10') throw new Error(await cell('C2').innerText());
  await cell('C3').click();
  await page.keyboard.type('=su');
  await page.getByRole('listbox', { name: 'Function suggestions' }).waitFor();
  await page.keyboard.press('Escape');
  if (await page.getByRole('listbox', { name: 'Function suggestions' }).count()) throw new Error('Escape should hide');
  if ((await page.getByLabel('Edit C3').inputValue()) !== '=su') throw new Error('still editing');
  await page.keyboard.press('Escape');
  await cell('C4').click();
  await page.getByLabel('Cell contents').click();
  await page.keyboard.type('=1+rou');
  await page.locator('.formula-bar').getByRole('option', { name: /ROUNDUP/ }).click();
  if ((await page.getByLabel('Cell contents').inputValue()) !== '=1+ROUNDUP(') throw new Error(await page.getByLabel('Cell contents').inputValue());
  await page.keyboard.type('2.1)');
  await page.keyboard.press('Enter');
  if ((await cell('C4').innerText()) !== '4') throw new Error(await cell('C4').innerText());
  await page.screenshot({ path: process.argv[2] + '/shots/assist.png' });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
