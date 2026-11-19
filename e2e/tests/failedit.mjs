// When a change can't be saved (the server answers with an error), the screen doesn't pretend it was: it
// says so. Renaming a file, a task's title, a note's text and an event's title are each changed with every
// change request made to fail; each must show an error (and after reloading, the old value is back).
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
const MSG = 'Something went wrong on the server';
const failing = () => page.route(/\/api\//, (route) => (['PATCH', 'PUT'].includes(route.request().method()) ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: MSG }) }) : route.continue()));
const ok = () => page.unrouteAll({ behavior: 'ignoreErrors' });
const said = async (what) => { if (!(await page.getByText(MSG).first().isVisible().catch(() => false))) await page.getByText(MSG).first().waitFor({ timeout: 4000 }).catch(() => { throw new Error(`${what}: no error shown`); }); };
const found = [];
const check = async (what, fn) => { try { await fn(); } catch (e) { found.push(`${what}: ${e.message.split('\n')[0]}`); } finally { await ok(); } };

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

await step('renaming a file', async () => check('rename', async () => {
  const f = (await api('POST', '/files/new', { kind: 'doc', name: 'Old name' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Old name' }).click();
  await page.getByRole('menuitem', { name: /Rename/ }).click();
  const box = page.getByRole('dialog').getByRole('textbox').first();
  await box.fill('New name');
  await failing();
  await box.press('Enter');
  await said('renaming a file');
  await ok();
  if ((await api('GET', `/files/${f.id}`)).body.name !== 'Old name') throw new Error('rename: saved after all?');
}));

await step('a task’s title', async () => check('task', async () => {
  const list = (await api('POST', '/tasks/lists', { name: 'Edit list' })).body;
  const t = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Old title' })).body;
  await page.goto(`${B}/tasks/${list.id}?task=${t.id}`);
  const title = page.getByRole('complementary', { name: 'Task details' }).getByLabel('Task', { exact: true });
  await title.waitFor();
  await failing();
  await title.fill('New title');
  await title.press('Enter');
  await page.waitForTimeout(800);
  await title.press('Tab').catch(() => {});
  await said('a task’s title');
}));

await step('a note’s text', async () => check('note', async () => {
  const n = (await api('POST', '/notes', { title: 'Note to change', body: 'Old text' })).body;
  await page.goto(`${B}/notes?note=${n.id}`);
  const body = page.getByRole('dialog').getByRole('textbox').nth(1);
  await body.waitFor();
  await failing();
  await body.fill('New text');
  await page.waitForTimeout(2500); // notes save as you type
  await said('a note’s text');
}));

await step('an event’s title', async () => check('event', async () => {
  const ev = (await api('POST', '/events', { title: 'Old event', start: Date.now() + 3600e3, end: Date.now() + 7200e3 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByText('Old event').first().click();
  const dlg = page.getByRole('dialog').first();
  const title = dlg.getByLabel('Title');
  if (!(await title.count())) await dlg.getByRole('button', { name: /Edit/ }).first().click();
  await dlg.getByLabel('Title').fill('New event');
  await failing();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await said('an event’s title');
  void ev;
}));

await step('every failed change was said', async () => { if (found.length) throw new Error(found.join(' | ')); });
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
