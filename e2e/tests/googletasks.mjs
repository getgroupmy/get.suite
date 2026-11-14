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
await step('Import from Google Tasks: each list comes in, with order, notes, due dates, done ones and subtasks as steps', async () => {
  const data = { kind: 'tasks#taskLists', items: [
    { title: 'House', items: [
      { id: 'a', title: 'Paint the hall', position: '0', status: 'needsAction', notes: 'Use the white', due: '2026-12-05T00:00:00.000Z' },
      { id: 'a1', title: 'Buy brushes', parent: 'a', position: '0', status: 'completed' },
      { id: 'b', title: 'Fix the tap', position: '1', status: 'completed', completed: '2026-10-01T09:00:00.000Z' },
    ] },
    { title: 'Work', items: [{ id: 'w', title: 'Send the report', position: '0', status: 'needsAction' }] },
  ] };
  await page.goto(`${B}/tasks`);
  await page.getByLabel('Google Tasks file').setInputFiles({ name: 'Tasks.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await page.getByText('Imported 2 lists with 3 tasks from Google Tasks').waitFor();
  await page.locator('.subnav-item', { hasText: 'House' }).waitFor();
  await page.locator('.subnav-item', { hasText: 'Work' }).waitFor();
  await page.getByText('Paint the hall').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/google-tasks.png` });
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const house = lists.find((l) => l.name === 'House');
  const got = (await api(page, 'GET', `/tasks/lists/${house.id}/tasks`)).body;
  const tasks = Array.isArray(got) ? got : got.tasks;
  const paint = tasks.find((t) => t.title === 'Paint the hall');
  if (paint.due !== '2026-12-05' || paint.notes !== 'Use the white' || paint.steps?.[0]?.title !== 'Buy brushes' || !paint.steps[0].done) throw new Error(JSON.stringify(paint));
  if (!tasks.find((t) => t.title === 'Fix the tap')?.done) throw new Error('done one not done');
  await page.getByLabel('Google Tasks file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await page.getByText('That isn’t a Google Tasks export (Tasks.json from Google Takeout)').waitFor();
});
await step('Import a Trello board: a list with its sections, cards, checklists and labels', async () => {
  const board = { name: 'Office move', lists: [{ id: 'l1', name: 'Next', pos: 1 }, { id: 'l2', name: 'Later', pos: 2 }],
    cards: [{ name: 'Book movers', idList: 'l1', pos: 1, labels: [{ name: 'Urgent' }], idChecklists: ['c1'] }, { name: 'Plan desks', idList: 'l2', pos: 1 }],
    checklists: [{ id: 'c1', checkItems: [{ name: 'Get three quotes', state: 'complete', pos: 1 }] }] };
  await page.getByLabel('Trello board file').setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(board)) });
  await page.getByText('Imported “Office move”: 2 tasks in 2 sections').waitFor();
  await page.locator('.subnav-item', { hasText: 'Office move' }).waitFor();
  await page.getByText('Book movers').first().waitFor();
  await page.getByText('Plan desks').first().waitFor();
  await page.getByText('#urgent').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/trello-import.png` });
});
await step('Import lists from CSV…: a spreadsheet with a List column (as Download your data gives) makes a list for each', async () => {
  const csv = 'List,Task,Notes,Due,Time,Done,For,Important\r\nGarden,Plant bulbs,,2026-11-20,,,,yes\r\nGarden,Rake leaves,,,,2026-11-01,,\r\nBooks,Read Middlemarch,Chapter 3 on,,,,,\r\n';
  await page.getByLabel('Task lists spreadsheet').setInputFiles({ name: 'Tasks.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('Imported 2 lists with 3 tasks').waitFor();
  await page.getByRole('heading', { name: 'Garden' }).first().waitFor();
  await page.getByText('Plant bulbs').first().waitFor();
  await page.locator('.subnav-item', { hasText: 'Books' }).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
