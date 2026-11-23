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
const NAMES = ['Kim Park', 'Raj Patel', 'Nora Quíll', 'Eddie Stone', 'Ana Lima', 'Bo Chen', 'Cy Marsh', 'Dee Holt', 'Finn Oak', 'Gus Vale'];
let note;
await step('a few colleagues: the tick-list has no Find box', async () => {
  for (const name of NAMES.slice(0, 3)) if ((await api(page, 'POST', '/users', { local: name.split(' ')[0].toLowerCase(), domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  note = (await api(page, 'POST', '/notes', { title: 'Offsite', body: 'Ideas' })).body;
  await page.goto(`${B}/notes`);
  await page.getByRole('article').filter({ hasText: 'Offsite' }).getByRole('button', { name: 'Share note' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share note' });
  await dlg.getByLabel(/Kim Park/).waitFor();
  if (await dlg.getByPlaceholder('Find people').count()) throw new Error('no Find box for three people');
  await page.keyboard.press('Escape');
});
await step('a whole company: Find people narrows the list by name, and what is ticked stays ticked', async () => {
  for (const name of NAMES.slice(3)) if ((await api(page, 'POST', '/users', { local: name.split(' ')[0].toLowerCase(), domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  await page.reload();
  await page.getByRole('article').filter({ hasText: 'Offsite' }).getByRole('button', { name: 'Share note' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share note' });
  const people = dlg.getByRole('list', { name: 'Colleagues' });
  await until(async () => (await people.getByRole('checkbox').count()) === 10);
  await dlg.getByText('Nobody ticked').waitFor();
  const find = dlg.getByPlaceholder('Find people');
  await find.fill('quill nora'); // words in any order, accents aside
  await until(async () => (await people.getByRole('checkbox').count()) === 1);
  await people.getByLabel(/Nora Quíll/).check();
  await find.fill('zz');
  await people.getByText('Nobody fits “zz”.').waitFor();
  await find.fill('vale');
  await people.getByLabel(/Gus Vale/).check();
  await page.screenshot({ path: `${SP}/shots/people-ticks.png` });
  await find.fill('');
  await until(async () => (await people.getByRole('checkbox').count()) === 10);
  await dlg.getByText('2 ticked').waitFor();
  if (!(await people.getByLabel(/Nora Quíll/).isChecked())) throw new Error('Nora was unticked');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const shared = (await api(page, 'GET', '/notes')).body.find((n) => n.id === note.id).shared.map((u) => u.name).sort().join('|');
  if (shared !== 'Gus Vale|Nora Quíll') throw new Error(shared);
});
await step('the same box where reviewers are chosen (Drive → Request approval)', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract' });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Contract' }).click();
  await page.getByRole('menuitem', { name: /Request approval/ }).click();
  const dlg = page.getByRole('dialog', { name: /Request approval/ });
  await dlg.getByPlaceholder('Find people').fill('chen');
  const people = dlg.getByRole('list', { name: 'Reviewers' });
  await until(async () => (await people.getByRole('checkbox').count()) === 1);
  await people.getByLabel(/Bo Chen/).check();
  await dlg.getByText('1 ticked').waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
