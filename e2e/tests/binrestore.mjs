// Deleted by mistake: a shared task list comes back with Undo, and a deleted form from Recently deleted, with
// everything in them, for everyone they were shared with.
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
let carolId, list, form;
await step('setup: a list shared with Carol, a form with responses', async () => {
  await owner.goto(B);
  await owner.getByLabel('Your company name').fill('Acme Trading');
  await owner.getByLabel('Company domain').fill('acme.com');
  await owner.getByLabel('Your full name').fill('Olivia Owner');
  await owner.getByLabel('Address before @').fill('olivia');
  await owner.getByLabel('Password', { exact: true }).fill('password123');
  await owner.getByLabel('Confirm password').fill('password123');
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await owner.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  carolId = (await api(owner, 'POST', '/users', { local: 'carol', domain: 'acme.com', name: 'Carol Cole', password: 'password123' })).body.id;
  list = (await api(owner, 'POST', '/tasks/lists', { name: 'Office move' })).body;
  await api(owner, 'PUT', `/tasks/lists/${list.id}/members`, { user_ids: [carolId] });
  for (const t of ['Book the van', 'Pack the kitchen']) await api(owner, 'POST', `/tasks/lists/${list.id}/tasks`, { title: t });
  form = (await api(owner, 'POST', '/forms', { title: 'Lunch order', questions: [{ id: 'm', type: 'short', title: 'Meal' }] })).body;
  const token = (await api(owner, 'GET', `/forms/${form.id}`)).body.token;
  for (const m of ['Pasta', 'Soup', 'Salad']) await owner.request.post(`${B}/api/public/forms/${token}`, { data: { answers: { m } }, headers: { 'x-requested-with': 'nas-workspace' } });
  await carol.goto(B);
  await carol.getByLabel(/Email/).first().fill('carol@acme.com');
  await carol.getByLabel(/Password/).first().fill('password123');
  await carol.getByRole('button', { name: /Sign in/ }).click();
  await carol.waitForTimeout(1500);
});

await step('a shared list deleted, then Undo: back with its tasks, for Carol too', async () => {
  await owner.goto(`${B}/tasks/${list.id}`);
  await owner.getByText('Book the van').first().waitFor();
  await owner.getByRole('button', { name: 'List actions' }).click();
  const item = owner.getByRole('menuitem', { name: 'Delete list' });
  if (!(await item.count())) throw new Error('no Delete list in the list menu');
  await item.click();
  const dlg = owner.getByRole('dialog');
  await dlg.getByText(/put it back from Recently deleted for 30 days/).waitFor();
  await dlg.getByRole('button', { name: 'Delete list' }).click();
  await owner.getByRole('button', { name: 'Undo' }).click();
  await owner.getByText('Pack the kitchen').first().waitFor({ timeout: 8000 });
  await carol.goto(`${B}/tasks/${list.id}`);
  await carol.getByText('Book the van').first().waitFor({ timeout: 8000 });
});

await step('a form deleted, then put back from Recently deleted with its responses', async () => {
  await owner.goto(`${B}/forms/${form.id}`);
  await owner.getByRole('tab', { name: /Responses \(3\)/ }).waitFor();
  await owner.getByRole('button', { name: 'More', exact: true }).first().click();
  await owner.getByRole('menuitem', { name: 'Delete form' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: /Delete/ }).click();
  await owner.waitForURL(/\/forms$/);
  await owner.waitForTimeout(6000); // past the Undo
  await owner.getByRole('button', { name: 'Recently deleted' }).click();
  const dlg = owner.getByRole('dialog', { name: 'Recently deleted forms' });
  await dlg.getByRole('button', { name: 'Restore Lunch order' }).click();
  await owner.waitForURL(new RegExp(`/forms/${form.id}`));
  await owner.getByRole('tab', { name: /Responses \(3\)/ }).waitFor({ timeout: 8000 });
});
await step('deleted for good: Carol’s bell says who deleted the list', async () => {
  const l2 = (await api(owner, 'POST', '/tasks/lists', { name: 'Holiday rota' })).body;
  await api(owner, 'PUT', `/tasks/lists/${l2.id}/members`, { user_ids: [carolId] });
  await api(owner, 'DELETE', `/tasks/lists/${l2.id}`);
  await carol.goto(`${B}/drive`);
  await carol.waitForTimeout(17000); // past the moment to undo
  await carol.getByRole('button', { name: /^Notifications/ }).first().click();
  await carol.getByText('Olivia Owner deleted the list “Holiday rota”').first().waitFor({ timeout: 8000 });
});
await step('Recently deleted forms: Delete forever the ticked ones, and Empty (asked first)', async () => {
  for (const title of ['Gone A', 'Gone B', 'Gone C']) { const f = (await api(owner, 'POST', '/forms', { title })).body; await api(owner, 'DELETE', `/forms/${f.id}`); }
  await owner.goto(`${B}/forms`);
  await owner.getByRole('button', { name: 'Recently deleted' }).click();
  const dlg = owner.getByRole('dialog', { name: 'Recently deleted forms' });
  await dlg.getByLabel('Select Gone A').check();
  await dlg.getByRole('button', { name: 'Delete forever' }).click();
  await owner.getByRole('dialog', { name: 'Delete 1 for good?' }).getByRole('button', { name: 'Delete forever' }).click();
  await owner.getByText('1 deleted for good').waitFor();
  await dlg.getByText('Gone A').waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Empty' }).click();
  await owner.getByRole('dialog', { name: /^Delete all \d+ here for good\?$/ }).getByRole('button', { name: 'Delete forever' }).click();
  await dlg.getByText('Nothing deleted lately').waitFor();
  if ((await api(owner, 'GET', '/forms/bin/list')).body.length) throw new Error('not empty');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
