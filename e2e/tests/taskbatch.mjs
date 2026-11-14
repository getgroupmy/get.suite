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
let launch, later;
const tasksOf = async (id) => (await api(page, 'GET', `/tasks/lists/${id}/tasks`)).body;
await step('setup: a list of tasks', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  launch = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  later = (await api(page, 'POST', '/tasks/lists', { name: 'Later' })).body.id;
  for (const title of ['Write copy', 'Design', 'Print flyers', 'Book venue']) await api(page, 'POST', `/tasks/lists/${launch}/tasks`, { title });
  await page.goto(`${B}/tasks/${launch}`);
  await page.getByText('Book venue').waitFor();
});
const choose = async (...titles) => { for (const t of titles) await page.getByLabel(`Select: ${t}`, { exact: true }).check(); };
await step('Select several and give them a due date and a star', async () => {
  if (await page.getByLabel('Select: Design', { exact: true }).count()) throw new Error('boxes before Select');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const bar = page.getByRole('toolbar', { name: 'Change the selected tasks' });
  await choose('Write copy', 'Design');
  // clicking a task's title picks it too, instead of opening it
  await page.locator('.task-main', { hasText: 'Print flyers' }).click();
  await bar.getByText('3 selected').waitFor();
  await bar.getByLabel('Due date for the selected tasks').fill('2026-12-01');
  await page.locator('.toast', { hasText: '3 tasks due' }).last().waitFor();
  await bar.getByText('0 selected').waitFor();
  const ts = await tasksOf(launch);
  if (ts.filter((t) => t.due === '2026-12-01').map((t) => t.title).sort().join() !== 'Design,Print flyers,Write copy') throw new Error(JSON.stringify(ts.map((t) => [t.title, t.due])));
  await choose('Design', 'Book venue');
  await bar.getByRole('button', { name: '★ Important' }).click();
  await page.locator('.toast', { hasText: '2 tasks marked important' }).last().waitFor();
  if ((await tasksOf(launch)).filter((t) => t.important).length !== 2) throw new Error('stars');
});
await step('Download (CSV): just the selected tasks', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected tasks' });
  await choose('Write copy', 'Book venue');
  await bar.getByText('2 selected').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download (CSV)' }).click()]);
  if (dl.suggestedFilename() !== 'Tasks (2).csv') throw new Error(dl.suggestedFilename());
  const csv = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!/Write copy/.test(csv) || !/Book venue/.test(csv) || /Design|Print flyers/.test(csv)) throw new Error(csv);
  await bar.getByText('2 selected').waitFor(); // still selected
  for (const t of ['Write copy', 'Book venue']) await page.getByLabel(`Select: ${t}`, { exact: true }).uncheck();
  await bar.getByText('0 selected').waitFor();
});
await step('Print: just the selected tasks', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected tasks' });
  await choose('Write copy', 'Book venue');
  await bar.getByRole('button', { name: 'Print' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /Book venue/.test(f.getAttribute('srcdoc') || ''); });
  const html = await page.locator('iframe.print-frame').last().getAttribute('srcdoc');
  if (!/Write copy/.test(html) || /Design|Print flyers/.test(html)) throw new Error(html.slice(0, 500));
  for (const t of ['Write copy', 'Book venue']) await page.getByLabel(`Select: ${t}`, { exact: true }).uncheck();
});
await step('Send in Chat…: links to the selected tasks wait in the channel’s message box', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'tasks-room' })).body.id;
  const bar = page.getByRole('toolbar', { name: 'Change the selected tasks' });
  await choose('Write copy');
  await bar.getByRole('button', { name: 'Send in Chat…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send the task in Chat' });
  await dlg.getByLabel('Conversation').selectOption({ label: '# tasks-room' });
  await dlg.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  await page.waitForFunction(() => /Write copy: .*\/tasks\/.+\?task=/.test(document.querySelector('textarea[aria-label="Message"]')?.value || ''));
  await page.goto(`${B}/tasks/${launch}`);
  await page.getByText('Book venue').waitFor();
  if (!(await page.getByLabel('Select: Design', { exact: true }).count())) await page.getByRole('button', { name: 'Select', exact: true }).click();
});
await step('Mark done, move, and delete with a confirmation', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected tasks' });
  await choose('Write copy');
  await bar.getByRole('button', { name: '✓ Mark done' }).click();
  await page.locator('.toast', { hasText: '1 task done' }).last().waitFor();
  await bar.getByRole('button', { name: 'Select all' }).click();
  await bar.getByText('3 selected').waitFor();
  await bar.getByLabel('Move the selected tasks to').selectOption({ label: 'Later' });
  await page.locator('.toast', { hasText: '3 tasks moved to Later' }).last().waitFor();
  if ((await tasksOf(later)).length !== 3) throw new Error('not moved');
  await page.goto(`${B}/tasks/${later}`);
  await page.getByText('Book venue').waitFor();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await choose('Book venue', 'Design');
  await page.getByRole('toolbar', { name: 'Change the selected tasks' }).getByRole('button', { name: 'Delete' }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete 2 tasks?' });
  await dlg.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.toast', { hasText: '2 tasks deleted' }).last().waitFor();
  if ((await tasksOf(later)).map((t) => t.title).join() !== 'Print flyers') throw new Error('delete');
  await page.screenshot({ path: `${SP}/shots/taskbatch.png` });
  await page.getByRole('button', { name: 'Done selecting' }).click();
  await page.getByRole('toolbar', { name: 'Change the selected tasks' }).waitFor({ state: 'detached' });
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
