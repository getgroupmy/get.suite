import { createRequire } from 'module'; const require = createRequire(import.meta.url);
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { chromium } from 'playwright';
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
let list;
await step('List actions → Download as CSV', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Office move' })).body;
  await api(page, 'POST', `/tasks/lists/${list.id}/tasks`, { title: 'Pack the books', due: '2026-12-01' });
  const t2 = (await api(page, 'POST', `/tasks/lists/${list.id}/tasks`, { title: 'Order boxes' })).body;
  await api(page, 'PATCH', `/tasks/tasks/${t2.id}`, { done: true });
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByText('Pack the books').first().waitFor();
  await page.getByRole('button', { name: 'List actions' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as CSV' }).click()]);
  if (dl.suggestedFilename() !== 'Office move.csv') throw new Error(dl.suggestedFilename());
  const text = require('fs').readFileSync(await dl.path(), 'utf8');
  if (!/Pack the books,To do,2026-12-01/.test(text) || !/Order boxes,Done/.test(text)) throw new Error(text);
});
await step('List actions → Print list opens a printable page', async () => {
  await page.evaluate(() => { window.__printed = 0; });
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Print list' }).click();
  const html = await until(() => page.evaluate(() => document.querySelector('iframe.print-frame')?.srcdoc || ''));
  if (!/<h1>Office move<\/h1>/.test(html) || !/Pack the books/.test(html) || !/<h2>Completed<\/h2>[\s\S]*Order boxes/.test(html)) throw new Error(html.slice(0, 300));
});
await step('List actions → Import from CSV adds the file\'s tasks at the end', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Import from CSV…' }).click()]);
  await chooser.setFiles({ name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Due date,Status\nLabel the boxes,15/12/2026,\nCancel old lease,,done\n') });
  await page.getByText('Added 2 tasks (1 already done)').waitFor();
  await page.getByText('Label the boxes').first().waitFor();
  const t = (await api(page, 'GET', `/tasks/lists/${list.id}/tasks`)).body;
  const label = t.find((x) => x.title === 'Label the boxes');
  if (label.due !== '2026-12-15' || label.done) throw new Error(JSON.stringify(label));
  if (!t.find((x) => x.title === 'Cancel old lease').done) throw new Error('done one');
});
await step('Import from CSV also reads a Todoist export: sections, subtasks as steps, @labels', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Import from CSV…' }).click()]);
  const csv = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\nsection,Packing,,,,,,,,\ntask,Pack the kitchen @boxes,,2,1,,,,,\ntask,Wrap glasses,,4,2,,,,,\n';
  await chooser.setFiles({ name: 'Moving.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('Added 1 task').first().waitFor();
  await page.getByText('Pack the kitchen').first().waitFor();
  const t = (await api(page, 'GET', `/tasks/lists/${list.id}/tasks`)).body;
  const k = t.find((x) => x.title === 'Pack the kitchen');
  if (!k || k.steps?.[0]?.title !== 'Wrap glasses' || k.tags?.[0] !== 'boxes' || k.priority !== 'medium') throw new Error(JSON.stringify(k));
});
await step('Import from CSV reads an Asana export: subtasks become the parent’s steps', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Import from CSV…' }).click()]);
  const csv = 'Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task\n1,,,,Plan launch party,Packing,,,,,,,,\n2,,2026-11-03,,Order cake,Packing,,,,,,,,Plan launch party\n';
  await chooser.setFiles({ name: 'asana.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('Plan launch party').first().waitFor();
  const t = (await api(page, 'GET', `/tasks/lists/${list.id}/tasks`)).body;
  const k = t.find((x) => x.title === 'Plan launch party');
  if (!k || k.steps?.[0]?.title !== 'Order cake' || !k.steps[0].done || t.some((x) => x.title === 'Order cake')) throw new Error(JSON.stringify(k));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
