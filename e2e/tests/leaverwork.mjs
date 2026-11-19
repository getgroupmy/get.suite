// Deleting someone who shared work: the Admin window says shared lists, forms and notes aren't deleted, and
// afterwards the colleague they were shared with still has them.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const carol = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [owner, carol]) p.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await owner.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let bobId, carolId, list;
await step('setup: Bob shares a task list with Carol', async () => {
  await owner.goto(B);
  await owner.getByLabel('Your company name').fill('Acme Trading');
  await owner.getByLabel('Company domain').fill('acme.com');
  await owner.getByLabel('Your full name').fill('Olivia Owner');
  await owner.getByLabel('Address before @').fill('olivia');
  await owner.getByLabel('Password', { exact: true }).fill('password123');
  await owner.getByLabel('Confirm password').fill('password123');
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await owner.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  bobId = (await api(owner, 'POST', '/users', { local: 'bob', domain: 'acme.com', name: 'Bob Brown', password: 'password123' })).body.id;
  carolId = (await api(owner, 'POST', '/users', { local: 'carol', domain: 'acme.com', name: 'Carol Cole', password: 'password123' })).body.id;
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  const h = { 'x-requested-with': 'nas-workspace' };
  await bob.request.post(`${B}/api/auth/login`, { data: { username: 'bob@acme.com', password: 'password123' }, headers: h });
  list = await (await bob.request.post(`${B}/api/tasks/lists`, { data: { name: 'Office move' }, headers: h })).json();
  await bob.request.put(`${B}/api/tasks/lists/${list.id}/members`, { data: { user_ids: [carolId] }, headers: h });
  await bob.request.post(`${B}/api/tasks/lists/${list.id}/tasks`, { data: { title: 'Book the van' }, headers: h });
  await bobCtx.close();
  await carol.goto(B);
  await carol.getByLabel(/Email/).first().fill('carol@acme.com');
  await carol.getByLabel(/Password/).first().fill('password123');
  await carol.getByRole('button', { name: /Sign in/ }).click();
  await carol.waitForTimeout(2000);
});

await step('Admin deletes Bob: told shared work stays, and what was kept', async () => {
  await owner.goto(`${B}/admin`);
  await owner.getByRole('button', { name: 'Actions for Bob Brown' }).click();
  await owner.getByRole('menuitem', { name: /Delete user/ }).click();
  const dlg = owner.getByRole('dialog', { name: /Delete Bob Brown/ });
  await dlg.getByText(/Task lists, forms and notes they shared with colleagues aren't deleted/).waitFor();
  await dlg.getByRole('button', { name: 'Delete user' }).click();
  await owner.getByText(/1 task list kept for the people they were shared with/).waitFor({ timeout: 8000 });
});

await step('Carol still has the list and its task, and owns it now', async () => {
  await carol.goto(`${B}/tasks/${list.id}`);
  await carol.getByText('Book the van').first().waitFor({ timeout: 8000 });
  const lists = await api(carol, 'GET', '/tasks/lists');
  const l = (lists.body.lists || lists.body).find((x) => x.id === list.id);
  if (l?.owner_id !== carolId) throw new Error(`owner is ${l?.owner_id}`);
  void bobId;
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
