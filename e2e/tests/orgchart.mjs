import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
let ids = {}, kim;
await step('people, and Kim fills in her own details in Settings', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['max', 'Max Lee'], ['ann', 'Ann Solo']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/settings`);
  const card = kim.getByRole('form', { name: 'About you' }).or(kim.locator('form[aria-labelledby="profile-h"]')).first();
  await card.getByLabel('Job title').fill('Designer');
  await card.getByLabel('Department').fill('Product');
  await card.getByLabel('Work phone').fill('+60 3-555 0101');
  await card.getByRole('button', { name: 'Save' }).click();
  await kim.getByText('Saved: colleagues see it in the Directory').waitFor();
});
await step('an admin sets managers in Admin → Users → Job and manager', async () => {
  await page.goto(`${B}/admin`);
  const setManager = async (who, manager, title) => {
    await page.getByRole('button', { name: `Actions for ${who}` }).click();
    await page.getByRole('menuitem', { name: 'Job and manager' }).click();
    const d = page.getByRole('dialog', { name: `Job and manager: ${who}` });
    if (title) await d.getByLabel('Job title').fill(title);
    await d.getByLabel('Reports to').selectOption({ label: manager });
    await d.getByRole('button', { name: 'Save' }).click();
    await d.waitFor({ state: 'detached' });
  };
  await setManager('Max Lee', 'Olivia Owner', 'Head of Product');
  await setManager('Kim Park', 'Max Lee');
  // A loop is refused.
  await page.getByRole('button', { name: 'Actions for Olivia Owner' }).click();
  await page.getByRole('menuitem', { name: 'Job and manager' }).click();
  const d = page.getByRole('dialog', { name: 'Job and manager: Olivia Owner' });
  await d.getByLabel('Reports to').selectOption({ label: 'Kim Park' });
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/That would make a loop/).waitFor();
  await d.getByRole('button', { name: 'Cancel' }).click();
});
await step('the Directory shows titles, and the org chart who reports to whom', async () => {
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Directory' }).click();
  await kim.getByRole('row', { name: /Kim Park/ }).getByText('Designer · Product').waitFor();
  await kim.getByRole('row', { name: /Kim Park/ }).getByText('+60 3-555 0101').waitFor();
  await kim.getByRole('button', { name: 'Org chart' }).click();
  const chart = kim.getByRole('list', { name: 'Org chart' });
  const olivia = chart.locator(':scope > li').filter({ has: kim.getByLabel('Olivia Owner', { exact: true }) });
  await olivia.waitFor();
  await olivia.locator('ul > li').filter({ has: kim.getByLabel('Max Lee, Head of Product', { exact: true }) }).locator('ul > li').getByLabel('Kim Park, Designer', { exact: true }).waitFor();
  await chart.locator(':scope > li').getByLabel('Ann Solo', { exact: true }).waitFor();
  // Filtering keeps the matches with their managers.
  await kim.getByLabel('Filter contacts').fill('designer');
  await until(async () => (await chart.locator('.org-card').count()) === 3);
  await chart.locator('.org-card.hit').getByText('Kim Park').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
