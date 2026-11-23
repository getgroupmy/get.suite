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
});

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
await step('a contact’s window says who else is at the company; a click opens them', async () => {
  for (const [name, company] of [['Ada Stone', 'Initrode Works'], ['Ben Vale', 'initrode  works'], ['Cy Marsh', 'Elsewhere Ltd'], ['Dee Holt', '']]) await api(page, 'POST', '/contacts', { name, company, email: `${name.split(' ')[0].toLowerCase()}@x.example` });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Edit Ada Stone' }).click();
  const dlg = page.getByRole('dialog');
  await until(async () => (await dlg.getByLabel('Name', { exact: true }).inputValue()) === 'Ada Stone');
  const also = dlg.locator('.also-at');
  await also.getByText('Also at Initrode Works:').waitFor();
  await page.screenshot({ path: `${SP}/shots/also-at.png` });
  await also.getByRole('button', { name: 'Ben Vale' }).click();
  await until(async () => (await dlg.getByLabel('Name', { exact: true }).inputValue()) === 'Ben Vale');
  await dlg.locator('.also-at').getByRole('button', { name: 'Ada Stone' }).waitFor(); // and back the other way
});
await step('with changes unsaved, the names don’t take you away', async () => {
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Job title').fill('Buyer');
  await dlg.locator('.also-at').getByRole('button', { name: 'Ada Stone' }).click();
  await page.getByText('Save or cancel your changes here first').waitFor();
  if ((await dlg.getByLabel('Name', { exact: true }).inputValue()) !== 'Ben Vale') throw new Error('it left Ben');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
});
await step('a new contact: the Company box offers the companies you have, and says who is there', async () => {
  await page.getByRole('button', { name: /New contact/ }).click();
  const dlg = page.getByRole('dialog');
  const offered = await dlg.locator('#contact-companies option').evaluateAll((os) => os.map((o) => o.value));
  if (offered.join('|') !== 'Elsewhere Ltd|Initrode Works' && offered.join('|') !== 'Elsewhere Ltd|initrode  works') throw new Error(offered.join('|'));
  if (await dlg.locator('.also-at').count()) throw new Error('nothing typed yet');
  await dlg.getByLabel('Company').fill('INITRODE WORKS');
  await dlg.locator('.also-at').getByRole('button', { name: 'Ada Stone' }).waitFor();
  await dlg.locator('.also-at').getByRole('button', { name: 'Ben Vale' }).waitFor();
  await dlg.getByLabel('Company').fill('Nowhere');
  await dlg.locator('.also-at').waitFor({ state: 'detached' });
});

await step('Email all: a message to everyone at the company, this contact included', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Edit Ada Stone' }).click();
  const dlg = page.getByRole('dialog');
  const also = dlg.locator('.also-at');
  await also.getByRole('button', { name: 'Email all 2' }).click();
  await page.waitForURL((u) => u.pathname === '/mail' && u.searchParams.has('compose'));
  const to = new URL(page.url()).searchParams.get('compose');
  if (to !== 'Ada Stone <ada@x.example>, Ben Vale <ben@x.example>') throw new Error(to);
});
await step('with changes unsaved, Email all keeps you here', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Edit Ada Stone' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Job title').fill('Buyer');
  await dlg.locator('.also-at').getByRole('button', { name: 'Email all 2' }).click();
  await page.getByText('Save or cancel your changes here first').waitFor();
  if (!page.url().endsWith('/contacts')) throw new Error(page.url());
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
