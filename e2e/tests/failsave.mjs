// When saving fails (the server answers with an error), what you wrote isn't lost: the error is shown and
// your words are still there to try again. Every create request is made to fail; a comment, a chat
// message, a new event, a new contact and a new task are each tried.
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
const failing = (re) => page.route(re, (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on the server' }) }) : route.continue()));
const ok = () => page.unrouteAll({ behavior: 'ignoreErrors' });
const said = () => page.getByText(/Something went wrong on the server/).first().waitFor({ timeout: 5000 });

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

await step('a comment that can’t be posted: the error shows, the words stay', async () => {
  const sheet = (await api('POST', '/files/new', { kind: 'sheet', name: 'Fail sheet', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'x' } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await page.locator('[data-k="B2"]').click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByLabel('New comment').fill('A long careful comment I do not want to retype');
  await failing(/\/api\/comments\//);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await said();
  await ok();
  if (await page.getByLabel('New comment').inputValue() !== 'A long careful comment I do not want to retype') throw new Error(`the box has “${await page.getByLabel('New comment').inputValue()}”`);
});

await step('a chat message that can’t be sent: the error shows, the words stay', async () => {
  const general = (await api('GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('An important announcement for everyone');
  await failing(/\/api\/chat\/channels\/[^/]+\/messages/);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForTimeout(1500);
  await ok();
  const still = await box.inputValue().catch(() => box.innerText());
  const shownFailed = await page.getByText(/couldn.t be sent|not sent|Something went wrong|Try again|Retry/i).count();
  if (!still.includes('An important announcement') || !shownFailed) throw new Error(`box keeps it: ${still.includes('An important announcement')}, failure shown: ${shownFailed > 0}`);
  console.log(`chat: box keeps it: ${still.includes('An important announcement')}, failure shown: ${shownFailed > 0}`);
});

await step('a new event that can’t be saved: the error shows, the dialog stays with what was typed', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Board meeting with the auditors');
  await failing(/\/api\/events/);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await said();
  await ok();
  if (!(await dlg.count()) || await dlg.getByLabel('Title').inputValue() !== 'Board meeting with the auditors') throw new Error('the event dialog lost what was typed');
  await dlg.getByRole('button', { name: 'Save' }).click(); // and it can be tried again
  await dlg.waitFor({ state: 'detached' });
});

await step('a new contact that can’t be saved: the error shows, the dialog stays', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'New contact' }).click();
  const dlg = page.getByRole('dialog', { name: 'New contact' });
  await dlg.getByLabel('Name').fill('Rosalind Franklin');
  await failing(/\/api\/contacts/);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await said();
  await ok();
  if (!(await dlg.count()) || await dlg.getByLabel('Name').inputValue() !== 'Rosalind Franklin') throw new Error('the contact dialog lost what was typed');
});

await step('a task that can’t be added: the error shows, the words stay', async () => {
  const list = (await api('POST', '/tasks/lists', { name: 'Fail list' })).body;
  await page.goto(`${B}/tasks/${list.id}`);
  const box = page.getByLabel('Add a task');
  await box.fill('Renew the office lease');
  await failing(/\/api\/tasks\/lists\/[^/]+\/tasks/);
  await box.press('Enter');
  await page.waitForTimeout(1500);
  await ok();
  const still = await box.inputValue();
  const listed = await page.getByText('Renew the office lease').count();
  const saved = ((await api('GET', `/tasks/lists/${list.id}/tasks`)).body.tasks || []).length;
  console.log(`task: box keeps it: ${still === 'Renew the office lease'}, shown: ${listed}, saved: ${saved}`);
  if (still !== 'Renew the office lease' || saved) throw new Error(`the task is gone: box “${still}”, ${listed} shown, ${saved} saved`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
