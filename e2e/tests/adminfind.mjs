import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
let kimId;
await step('five groups and five shared drives', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  for (const name of ['Sales', 'Marketing', 'Finance', 'Support', 'Design']) {
    const g = (await api(page, 'POST', '/groups', { name })).body;
    if (name === 'Finance') await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [kimId] });
  }
  for (const name of ['Brand assets', 'Contracts', 'Board papers', 'Product specs', 'Photos']) await api(page, 'POST', '/files/drives', { name });
});
await step('Admin → Groups: find a group by its name, or by someone in it', async () => {
  await page.goto(`${B}/admin?tab=groups`);
  const groups = page.locator('.group-list > li');
  await until(async () => (await groups.count()) === 5);
  const box = page.getByLabel('Find a group');
  await box.fill('mark');
  await until(async () => (await groups.count()) === 1);
  await page.getByRole('listitem', { name: 'Group Marketing' }).waitFor();
  await box.fill('kim park');
  await until(async () => (await groups.count()) === 1);
  await page.getByRole('listitem', { name: 'Group Finance' }).waitFor(); // Kim is in it
  await box.fill('nothing like it');
  await page.getByText('No group fits “nothing like it”.').waitFor();
});
await step('Admin → Shared drives: find a drive by its name or its owner', async () => {
  await page.goto(`${B}/admin?tab=drives`);
  const rows = page.locator('table.files tbody tr');
  await until(async () => (await rows.count()) === 5);
  const box = page.getByLabel('Find a shared drive');
  await box.fill('papers board');
  await until(async () => (await rows.count()) === 1);
  await rows.first().getByText('Board papers').waitFor();
  await box.fill('olivia'); // the owner of them all
  await until(async () => (await rows.count()) === 5);
  await box.fill('zzz');
  await page.getByText('No shared drive fits “zzz”.').waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
