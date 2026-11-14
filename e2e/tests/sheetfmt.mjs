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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Price', A2: 'Bolts', B2: '1234.5', A3: 'Margin', B3: '0.125', B4: '=B2*2' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});

await step('currency, another currency, fewer decimals; the value stays the same', async () => {
  await cell('B2').click();
  await page.getByLabel('Number format').selectOption('currency');
  if (!(await cell('B2').innerText()).includes('1,234.50')) throw new Error(await cell('B2').innerText());
  await page.getByLabel('Currency').selectOption('USD');
  if ((await cell('B2').innerText()) !== '$1,234.50') throw new Error(await cell('B2').innerText());
  await page.getByRole('button', { name: 'Fewer decimals' }).click();
  if ((await cell('B2').innerText()) !== '$1,234.5') throw new Error(await cell('B2').innerText());
  await page.getByRole('button', { name: 'Fewer decimals' }).click();
  if ((await cell('B2').innerText()) !== '$1,235') throw new Error(await cell('B2').innerText());
  if ((await page.getByLabel('Cell contents').inputValue()) !== '1234.5') throw new Error('value changed');
  if ((await cell('B4').innerText()) !== '2469') throw new Error('formulas use the real value');
});

await step('percent with a decimal', async () => {
  await cell('B3').click();
  await page.getByLabel('Number format').selectOption('percent');
  await page.getByRole('button', { name: 'More decimals' }).click();
  if ((await cell('B3').innerText()) !== '12.5%') throw new Error(await cell('B3').innerText());
});

await step('bold with Ctrl+B, fill, centre a range', async () => {
  await cell('A1').click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+b');
  await page.getByLabel('Fill colour').selectOption({ label: 'Light yellow' });
  await page.getByRole('button', { name: 'Centre' }).click();
  for (const k of ['A1', 'B1']) {
    if ((await style(k, 'fontWeight')) !== '700') throw new Error(`${k} not bold`);
    if ((await style(k, 'textAlign')) !== 'center') throw new Error(`${k} not centred`);
    if ((await style(k, 'backgroundColor')) !== 'rgb(254, 247, 224)') throw new Error(`${k} fill ${await style(k, 'backgroundColor')}`);
  }
  if ((await page.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')) !== 'true') throw new Error('toolbar not showing bold');
  await cell('A2').click();
  if ((await page.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')) !== 'false') throw new Error('bold shown on a plain cell');
  await page.screenshot({ path: `${SP}/shots/sheetfmt.png` });
});

await step('copy and paste carry the format', async () => {
  await cell('B2').click();
  await page.keyboard.press('Control+c');
  await cell('C2').click();
  await page.keyboard.press('Control+v');
  if ((await cell('C2').innerText()) !== '$1,235') throw new Error(await cell('C2').innerText());
});

await step('clear formatting', async () => {
  await cell('C2').click();
  await page.getByRole('button', { name: 'Clear formatting' }).click();
  if ((await cell('C2').innerText()) !== '1234.5') throw new Error(await cell('C2').innerText());
});

await step('formats are saved', async () => {
  await saved();
  await page.reload();
  await cell('B2').waitFor();
  if ((await cell('B2').innerText()) !== '$1,235') throw new Error(await cell('B2').innerText());
  if ((await style('A1', 'fontWeight')) !== '700') throw new Error('bold lost');
  if ((await cell('B3').innerText()) !== '12.5%') throw new Error('percent lost');
});

await step('viewers see formats but no toolbar', async () => {
  await api(page, 'POST', '/users', { local: 'vic', domain: 'acme.com', name: 'Vic Viewer', password: 'password123' });
  const vic = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'vic@acme.com');
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: vic.id, role: 'viewer' }] });
  const ctx = await browser.newContext(); const v = await ctx.newPage();
  await v.goto(B);
  await v.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic@acme.com', password: 'password123' }) }));
  await v.goto(`${B}/sheets/${sheet.id}`);
  await v.locator('.grid td[data-k="B2"]', { hasText: '$1,235' }).waitFor();
  if (await v.getByRole('toolbar', { name: 'Cell formatting' }).count()) throw new Error('toolbar shown to a viewer');
  await ctx.close();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
