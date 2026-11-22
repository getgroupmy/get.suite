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
const card = (name) => page.getByRole('article', { name });
await step('a checklist note', async () => {
  await api(page, 'POST', '/notes', { title: 'Trip', items: [{ text: 'Book hotel' }, { text: 'Passport', done: true }, { text: 'Taxi' }] });
  await page.goto(`${B}/notes`);
  await card('Trip').waitFor();
});
await step('copy unticked items to Tasks', async () => {
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy unticked items to Tasks' }).click();
  await page.getByText('2 tasks added to My tasks').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/tasks\//);
  await page.locator('.task', { hasText: 'Book hotel' }).waitFor();
  await page.locator('.task', { hasText: 'Taxi' }).waitFor();
});
await step('each task links back to the note it came from', async () => {
  await page.locator('.task', { hasText: 'Taxi' }).getByText('Taxi').click();
  const link = page.getByRole('link', { name: 'Note: Trip' });
  await link.waitFor();
  if (!(await link.textContent()).includes('📝')) throw new Error(await link.textContent());
  await link.click();
  await page.waitForURL(/\/notes/);
  await page.getByRole('dialog', { name: 'Trip' }).getByRole('button', { name: 'Close', exact: true }).last().click(); // (the note, open)
});
await step('Schedule time for it…: a new event with the note in it, saved to the calendar', async () => {
  await page.goto(`${B}/notes`);
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Schedule time for it…' }).click();
  await page.waitForURL(/\/calendar/);
  const dlg = page.getByRole('dialog', { name: 'New event' });
  if ((await dlg.getByLabel('Title').inputValue()) !== 'Trip') throw new Error(await dlg.getByLabel('Title').inputValue());
  const text = await dlg.getByLabel('Description').inputValue();
  if (!/^☐ Book hotel\n☑ Passport\n☐ Taxi\n\nFrom my notes: https?:\/\/[^/\s]+\/notes\?note=[\w-]+$/.test(text)) throw new Error(text);
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  const now = Date.now();
  const evs = (await api(page, 'GET', `/events?from=${now - 864e5}&to=${now + 2 * 864e5}`)).body;
  const ev = (Array.isArray(evs) ? evs : evs.events || []).find((e) => e.title === 'Trip');
  if (!ev || !/Book hotel/.test(ev.description) || ev.start <= now || ev.end - ev.start !== 36e5) throw new Error(JSON.stringify(ev));
});
await step('copy to a document', async () => {
  await page.goto(`${B}/notes`);
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a document' }).click();
  await page.getByText('Copied to a new document in My Drive').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror h1', { hasText: 'Trip' }).waitFor();
  await page.locator('.ProseMirror li[data-checked="true"]', { hasText: 'Passport' }).waitFor();
});
await step('with a second task list: Copy to Tasks asks which list, and the items go there', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Trip prep' })).body.id;
  await page.goto(`${B}/notes`);
  await card('Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy unticked items to Tasks' }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy to Tasks' });
  await dlg.getByLabel('List').selectOption({ label: 'Trip prep' });
  await dlg.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByText('2 tasks added to Trip prep').waitFor();
  const tasks = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.map((t) => t.title).sort();
  if (tasks.join() !== 'Book hotel,Taxi') throw new Error(tasks.join());
});
await step('an AI assistant’s create_task goes to the list chosen with Use for Add to Tasks', async () => {
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists.find((l) => l.name === 'Trip prep').id;
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Use for Add to Tasks' }).click();
  await page.getByText('now uses “Trip prep”').waitFor();
  // The sidebar marks that list (and only it).
  const nav = page.getByRole('button', { name: /Trip prep/ }).filter({ has: page.getByRole('img', { name: 'Add to Tasks puts things here' }) });
  await nav.first().waitFor();
  if ((await page.getByRole('img', { name: 'Add to Tasks puts things here' }).count()) !== 1) throw new Error('one list is marked');
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Task helper', scope: 'write', days: 30 })).body.token;
  const r = await page.evaluate(async (t) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Renew travel insurance' } } }) })).json()).result, tok);
  if (r?.isError || r.structuredContent.list !== 'Trip prep') throw new Error(JSON.stringify(r));
  await page.goto(`${B}/tasks/${list}`);
  await page.locator('.task', { hasText: 'Renew travel insurance' }).waitFor();
});
await step('an assistant’s create_task about the note: the task links back to it and opens it', async () => {
  const note = (await api(page, 'GET', '/notes')).body.find((n) => n.title === 'Trip');
  const tok = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Linker', scope: 'write', days: 30 })).body.token;
  const r = await page.evaluate(async ([t, about]) => (await (await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Check the trip note', about, about_title: 'Note: Trip' } } }) })).json()).result, [tok, `/notes?note=${note.id}`]);
  if (r?.isError || !/\/notes\?note=/.test(r.structuredContent.about || '')) throw new Error(JSON.stringify(r));
  const list = (await api(page, 'GET', '/tasks/lists')).body.lists.find((l) => l.name === 'Trip prep').id;
  await page.goto(`${B}/tasks/${list}`);
  await page.locator('.task', { hasText: 'Check the trip note' }).getByText('Check the trip note').click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: 'Note: Trip' }).click();
  await page.waitForURL(/\/notes/);
  await page.getByRole('dialog', { name: 'Trip' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
