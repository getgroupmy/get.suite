import JSZip from '../../server/node_modules/jszip/lib/index.js';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { chromium } from 'playwright';
import * as require_fs from 'node:fs';
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
await step('some data', async () => {
  const plan = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' })).body;
  await api(page, 'POST', `/comments/${plan.id}`, { body: 'Check the kite budget', anchor: { quote: 'kites' } });
  await api(page, 'POST', '/notes', { title: 'Idea', body: 'Kites' });
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'kite-club' })).body;
  await api(page, 'POST', `/chat/channels/${ch.id}/messages`, { body: 'Flying on Sunday' });
  await api(page, 'POST', '/forms', { title: 'Kite sizes', questions: [{ id: 'q', type: 'short', title: 'Your size' }] });
  const kl = (await api(page, 'POST', '/tasks/lists', { name: 'Kites' })).body.id;
  const kt = (await api(page, 'POST', `/tasks/lists/${kl}/tasks`, { title: 'Buy string' })).body.id;
  await api(page, 'PATCH', `/tasks/tasks/${kt}`, { due: '2026-12-05' });
  const et = await api(page, 'POST', '/events/templates', { name: 'Kite lesson', event: { title: 'Kite lesson', minutes: 60 } });
  if (et.status !== 201) throw new Error(`event template ${et.status} ${JSON.stringify(et.body)}`);
});
await step('Settings shows what is in it and downloads one zip', async () => {
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'Download your data' });
  await sec.getByText(/1 file .* 1 note · 1 comment · 1 conversation · 1 form/).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), sec.getByRole('link', { name: /Download your data/ }).click()]);
  if (!/^Workspace data .*\.zip$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
  const zip = await JSZip.loadAsync(require_fs.readFileSync(await dl.path()));
  for (const n of ['Drive/Plan.docx', 'Notes.md', 'Notes/Idea.md', 'Calendar.ics']) if (!zip.files[n]) throw new Error(`missing ${n}`);
  const tcsv = await zip.file('Tasks.csv').async('string');
  if (!/^\uFEFF?List,Task,Status,/.test(tcsv)) throw new Error(tcsv.slice(0, 120));
  const hcsv = await zip.file('Task history.csv')?.async('string');
  if (!/Kites,Buy string,[^,]+,Olivia Owner,Due,,2026-12-05/.test(hcsv || '')) throw new Error(`Task history.csv: ${hcsv}`);
  const comments = await zip.file('Comments.csv')?.async('string');
  if (!/Plan,“kites”,Olivia Owner,[^,]+,Check the kite budget/.test(comments || '')) throw new Error(`Comments.csv: ${comments}`);
  const chat = await zip.file('Chat/kite-club.txt')?.async('string');
  if (!(await zip.file('Calendar templates.json')?.async('string'))?.includes('Kite lesson')) throw new Error('no event template');
  if (!(await zip.file('Forms/Kite sizes - questions.md')?.async('string'))?.includes('Your size')) throw new Error('no form');
  if (!/Flying on Sunday/.test(chat || '')) throw new Error(`Chat: ${Object.keys(zip.files).filter((n) => n.startsWith('Chat')).join(', ')}`);
});
await step('Notes → Import notes… takes the whole download and brings in just its notes', async () => {
  const res = await page.request.get(`${B}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace' } });
  if (!res.ok()) throw new Error(`takeout ${res.status()}`);
  const buf = await res.body();
  await api(page, 'DELETE', `/notes/${(await api(page, 'GET', '/notes')).body.find((n) => n.title === 'Idea').id}`);
  await page.goto(`${B}/notes`);
  await page.getByLabel('Notes to import').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: buf });
  await page.getByText('1 note imported').first().waitFor();
  await page.locator('article.note-card', { hasText: 'Kites' }).first().waitFor();
  if (await page.locator('article.note-card', { hasText: 'Flying on Sunday' }).count()) throw new Error('chat came in as a note');
});
await step('Settings → Bring in your data…: the download goes back in (lists and notes as new, nothing doubled)', async () => {
  await api(page, 'POST', '/contacts', { name: 'Ada Lovelace', email: 'ada@example.com' });
  const res = await page.request.get(`${B}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const buf = await res.body();
  const before = (await api(page, 'GET', '/contacts')).body.length;
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: buf });
  await page.locator('.toast', { hasText: /^Brought in / }).first().waitFor();
  const msg = await page.locator('.toast', { hasText: /^Brought in / }).first().innerText();
  if (!/0 contacts/.test(msg) || !/notes?/.test(msg) || !/0 event templates/.test(msg)) throw new Error(msg);
  if ((await api(page, 'GET', '/contacts')).body.length !== before) throw new Error('contacts doubled');
  if (!/file.* into “From your data \d{4}-\d{2}-\d{2}” in Drive/.test(msg)) throw new Error(msg);
  await page.goto(`${B}/drive`);
  await page.getByText(/^From your data \d{4}-/).first().dblclick();
  await page.getByText('Plan.docx').first().waitFor();
});
await step('the activity log records it', async () => {
  const r = await api(page, 'GET', '/audit?limit=20');
  const list = Array.isArray(r.body) ? r.body : r.body.entries || r.body.items || [];
  if (!list.some((e) => e.action === 'data.export')) throw new Error(JSON.stringify(r.body).slice(0, 200));
});
await step('an admin downloads a colleague’s data from Admin → Users', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  void kim;
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download their data (.zip)' }).click()]);
  if (!/kim@acme\.com/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
});
await step('Admin → Users → Bring in their data…: a download goes into a colleague’s account', async () => {
  const res = await page.request.get(`${B}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const buf = await res.body();
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Bring in their data…' }).click()]);
  await chooser.setFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: buf });
  await page.locator('.toast', { hasText: /^Kim Park: brought in / }).first().waitFor();
  const kim = (await api(page, 'GET', '/users')).body.find((u) => u.name === 'Kim Park');
  const audit = (await api(page, 'GET', '/audit?limit=20')).body;
  const list = Array.isArray(audit) ? audit : audit.entries || audit.items || [];
  if (!list.some((e) => e.action === 'takeout.restore' && /kim@acme\.com/.test(e.target || ''))) throw new Error(JSON.stringify(list.slice(0, 3)));
  void kim;
});
await step('Settings → Bring in from Drive…: a .zip already in Drive goes in from there', async () => {
  const res = await page.request.get(`${B}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const up = await page.request.post(`${B}/api/files/upload?name=${encodeURIComponent('My old data.zip')}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/zip' }, data: await res.body() });
  if (!up.ok()) throw new Error(`upload ${up.status()}`);
  await page.goto(`${B}/settings`);
  await page.getByRole('button', { name: 'Bring in from Drive…' }).click();
  await page.getByRole('dialog', { name: 'Bring in a Download your data .zip' }).getByText('My old data.zip').click();
  await page.locator('.toast', { hasText: /^Brought in .*into “From your data/ }).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
