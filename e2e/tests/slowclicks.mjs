// A slow server and an impatient click: pressing Create (or Save) twice while the first is still on its
// way makes one thing, not two. Every create request is held back two seconds; a new folder, a new
// contact, a new event and a new task list are each double-clicked, then counted.
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
const slow = async () => page.route(/\/api\//, async (route) => {
  if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2000));
  await route.continue();
});
const fast = () => page.unrouteAll({ behavior: 'ignoreErrors' });
// Two clicks, the second while the first is still on its way.
const twice = async (button) => { await button.click(); await button.click({ timeout: 1000 }).catch(() => {}); };

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

const found = [];
await step('a new folder: Create twice makes one', async () => {
  await page.goto(`${B}/drive`);
  await slow();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const dlg = page.getByRole('dialog', { name: 'New folder' });
  await dlg.getByLabel('Folder name').fill('Twice folder');
  await twice(dlg.getByRole('button', { name: 'Create' }));
  await page.waitForTimeout(5000);
  await fast();
  const n = (await api('GET', '/files?view=mine')).body.filter((f) => f.name === 'Twice folder').length;
  if (n !== 1) found.push(`folder: ${n}`);
});
await step('a new contact: Save twice makes one', async () => {
  await page.goto(`${B}/contacts`);
  await slow();
  await page.getByRole('button', { name: 'New contact' }).click();
  const dlg = page.getByRole('dialog', { name: 'New contact' });
  await dlg.getByLabel('Name').fill('Twice Contact');
  await twice(dlg.getByRole('button', { name: 'Save' }));
  await page.waitForTimeout(5000);
  await fast();
  const n = (await api('GET', '/contacts')).body.filter((c) => c.name === 'Twice Contact').length;
  if (n !== 1) found.push(`contact: ${n}`);
});
await step('a new event: Save twice makes one', async () => {
  await page.goto(`${B}/calendar`);
  await slow();
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Twice event');
  await twice(dlg.getByRole('button', { name: 'Save' }));
  await page.waitForTimeout(5000);
  await fast();
  const from = Date.now() - 864e5 * 40, to = Date.now() + 864e5 * 40;
  const n = (await api('GET', `/events?from=${from}&to=${to}`)).body.filter((e) => e.title === 'Twice event').length;
  if (n !== 1) found.push(`event: ${n}`);
});
await step('a new task list: Create twice makes one', async () => {
  await page.goto(`${B}/tasks`);
  await slow();
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('List name').fill('Twice list');
  await twice(page.getByRole('button', { name: 'Create' }));
  await page.waitForTimeout(5000);
  await fast();
  const lists = (await api('GET', '/tasks/lists')).body;
  const n = (lists.lists || lists).filter((l) => l.name === 'Twice list').length;
  if (n !== 1) found.push(`task list: ${n}`);
});
await step('one of each', async () => { if (found.length) throw new Error(found.join('; ')); });
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
