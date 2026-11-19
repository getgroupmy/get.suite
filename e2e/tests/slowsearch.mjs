// Searching as you type, with a slow server: an answer for what you'd typed earlier that arrives after
// the answer for what you typed last doesn't replace it. Drive's file picker (From Drive on a task) is
// checked: "Rep" answers late, "Report 7" at once; the list ends up showing Report 7 alone.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let list, task;

await step('setup: nine reports, a task', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (let i = 1; i <= 9; i++) await api('POST', '/files/new', { kind: 'doc', name: `Report ${i}` });
  list = (await api('POST', '/tasks/lists', { name: 'Slow list' })).body;
  task = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Attach the report' })).body;
});

await step('Drive’s picker: a late answer for “Rep” doesn’t replace the one for “Report 7”', async () => {
  await page.route(/\/api\/files\?view=search&q=Rep$/, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  await page.goto(`${B}/tasks/${list.id}?task=${task.id}`);
  await page.getByRole('button', { name: 'From Drive' }).click();
  const dlg = page.getByRole('dialog', { name: 'Attach to the task' });
  const box = dlg.getByLabel('Search your files');
  await box.fill('Rep');
  await page.waitForTimeout(500); // its search has gone out (slow)
  await box.fill('Report 7');
  await dlg.getByText('Report 7').waitFor();
  await page.waitForTimeout(3000); // the late answer for "Rep" has come
  const shown = await dlg.locator('.pick-list li').allInnerTexts();
  if (shown.length !== 1 || !/Report 7/.test(shown[0])) throw new Error(`shows ${JSON.stringify(shown)}`);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
