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
let file;
await step('Share: colleagues are found by name as you type; a click adds them', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['kimberly', 'Kimberly Ortíz'], ['raj', 'Raj Patel']]) if ((await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  file = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const dlg = page.getByRole('dialog', { name: /Share “Plan”/ });
  const box = dlg.getByLabel('Email address');
  const list = dlg.getByRole('listbox', { name: 'People to share with' });
  await box.pressSequentially('park kim'); // the words of a name in any order
  await list.getByRole('option').filter({ hasText: 'Kim Park' }).getByText('kim@acme.com').waitFor();
  if (await list.getByRole('option').count() !== 1) throw new Error('only Kim Park fits');
  await page.screenshot({ path: `${SP}/shots/share-pick.png` });
  await list.getByRole('option').first().click();
  await dlg.locator('.share-list').getByText('Kim Park').waitFor();
  if (await box.inputValue() !== '') throw new Error('the box should be empty again');
});
await step('arrows and Enter pick; someone already added is not offered; a name typed alone is added by Add', async () => {
  const dlg = page.getByRole('dialog', { name: /Share “Plan”/ });
  const box = dlg.getByLabel('Email address');
  const list = dlg.getByRole('listbox', { name: 'People to share with' });
  await box.pressSequentially('kim');
  await list.getByRole('option').filter({ hasText: 'Kimberly Ortíz' }).waitFor();
  if (await list.getByRole('option').count() !== 1) throw new Error('Kim Park already has access');
  await box.fill('');
  await dlg.getByLabel('Access', { exact: true }).selectOption('editor');
  await box.pressSequentially('ortiz'); // accents aside
  await list.getByRole('option').filter({ hasText: 'Kimberly Ortíz' }).waitFor();
  await box.press('Enter');
  await dlg.locator('.share-list').getByText('Kimberly Ortíz').waitFor();
  await box.pressSequentially('raj patel');
  await box.press('Escape'); // closes the list, not the dialog
  await list.waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.locator('.share-list').getByText('Raj Patel').waitFor();
  await box.fill('nobody at all');
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByRole('alert').getByText(/No colleague by that name/).waitFor();
  await box.fill('');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const shares = (await api(page, 'GET', `/files/${file.id}/shares`)).body.map((x) => `${x.username}:${x.role}`).sort().join(' ');
  if (shares !== 'kim@acme.com:viewer kimberly@acme.com:editor raj@acme.com:editor') throw new Error(shares);
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
