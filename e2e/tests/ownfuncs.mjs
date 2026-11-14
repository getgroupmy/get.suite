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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Prices', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', B1: '3', B2: '5', B3: '7', B4: '9', B5: '12' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('a named function is written once in ⋮ → Named functions', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Named functions' }).click();
  const dlg = page.getByRole('dialog', { name: 'Named functions' });
  await dlg.getByLabel('Name').fill('sum');
  await dlg.getByLabel('Formula').fill('=x');
  await dlg.getByRole('button', { name: 'Add function' }).click();
  await dlg.getByRole('alert').filter({ hasText: 'SUM is already a function' }).waitFor();
  await dlg.getByLabel('Name').fill('WithTax');
  await dlg.getByLabel('Arguments (separated by commas)').fill('amount');
  await dlg.getByLabel('Formula').fill('=ROUND(amount * 1.2, 2)');
  await dlg.getByLabel('Description (shown while typing it)').fill('Adds 20% sales tax');
  await dlg.getByRole('button', { name: 'Add function' }).click();
  await dlg.getByRole('list', { name: 'Functions' }).getByText('WITHTAX(amount)').waitFor();
  await dlg.screenshot({ path: `${SP}/shots/named-functions.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
});
await step('it is suggested while typing, with its help, and works like any function', async () => {
  await cell('C1').click();
  await page.keyboard.type('=with');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.getByRole('option', { name: /WITHTAX/ }).waitFor();
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if (!(await help.innerText()).includes('Adds 20% sales tax')) throw new Error(await help.innerText());
  await page.keyboard.type('B1)');
  await page.keyboard.press('Enter');
  await cell('C2').click(); await page.keyboard.type('=SUM(MAP(B1:B5, LAMBDA(v, WITHTAX(v))))'); await page.keyboard.press('Enter');
  await until(async () => (await cell('C1').innerText()).trim() === '3.6' && (await cell('C2').innerText()).trim() === '43.2');
});
await step('changing it changes every cell that uses it, for a colleague too', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: dir.find((x) => x.username === 'kim@acme.com').id, role: 'editor' }] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const kim = await ctx.newPage();
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim.goto(`${B}/sheets/${sheet.id}`);
  const kcell = (k) => kim.locator(`.grid td[data-k="${k}"]`);
  await until(async () => (await kcell('C1').innerText()).trim() === '3.6');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Named functions' }).click();
  const dlg = page.getByRole('dialog', { name: 'Named functions' });
  await dlg.getByRole('button', { name: 'Change WITHTAX' }).click();
  await dlg.getByLabel('Formula').fill('=ROUND(amount * 1.1, 2)');
  await dlg.getByRole('button', { name: 'Save function' }).click();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await until(async () => (await cell('C1').innerText()).trim() === '3.3');
  await until(async () => (await kcell('C1').innerText()).trim() === '3.3', 10000);
  await ctx.close();
});
await step('the Excel download keeps it as a LAMBDA name', async () => {
  await page.waitForTimeout(2000);
  const r = await page.evaluate(async (id) => { const res = await fetch(`/api/files/${id}/export`); return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] }; }, sheet.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(r.bytes))).file('xl/workbook.xml').async('string');
  if (!xml.includes('<definedName name="WITHTAX" comment="Adds 20% sales tax">_xlfn.LAMBDA(_xlpm.amount, ROUND(_xlpm.amount * 1.1, 2))</definedName>')) throw new Error(xml.slice(xml.indexOf('<definedNames'), xml.indexOf('<definedNames') + 400));
});
await step('a published copy works out its formulas with them', async () => {
  const on = (await api(page, 'PUT', `/publish/${sheet.id}`, { on: true })).body;
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto(B + on.path);
  await anon.getByRole('cell', { name: '3.3', exact: true }).first().waitFor();
  await ctx.close();
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
