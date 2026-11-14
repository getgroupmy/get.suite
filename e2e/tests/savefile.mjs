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

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const kim = await mk('kim');
let dm, msg, multi;
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${n}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, body: t })).json(), [name, text]);
await step('Kim sends Olivia a file, then two', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await signIn(kim, 'kim@acme.com');
  const oliviaId = (await api(page, 'GET', '/auth/me')).body.id || (await api(page, 'GET', '/me')).body?.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  const f = await upload(kim, 'quote.txt', 'Quote for the job');
  msg = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'The quote', files: [f.id] })).body;
  const g = await upload(kim, 'a.txt', 'A'), h = await upload(kim, 'b.txt', 'B');
  multi = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'Two more', files: [g.id, h.id] })).body;
  if (!msg.id || !multi.id) throw new Error(JSON.stringify(msg) + oliviaId);
});
await step('hover the message: Save to Drive, then Show in Drive opens it', async () => {
  await page.goto(`${B}/chat/${dm}`);
  const row = page.locator(`[data-mid="${msg.id}"]`).first();
  await row.hover();
  await row.getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByRole('menuitem', { name: 'Save to My Drive' }).click();
  await page.getByText('Saved “quote.txt” to My Drive').waitFor();
  await page.getByRole('button', { name: 'Show in Drive' }).click();
  await page.waitForURL(/\/drive\?preview=/);
  const mine = (await api(page, 'GET', '/files')).body.filter((x) => x.name === 'quote.txt');
  if (mine.length !== 1 || mine[0].role !== 'owner') throw new Error(JSON.stringify(mine));
});
await step('a message with two files: a menu to pick which', async () => {
  await page.goto(`${B}/chat/${dm}`);
  const row = page.locator(`[data-mid="${multi.id}"]`).first();
  await row.hover();
  await row.getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByRole('menuitem', { name: 'Save “b.txt” to My Drive' }).click();
  await page.getByText('Saved “b.txt” to My Drive').waitFor();
});
await step('your own attachments have no Save to Drive', async () => {
  const f = await upload(page, 'mine.txt', 'mine');
  const own = (await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'Mine', files: [f.id] })).body;
  await page.goto(`${B}/chat/${dm}`);
  const row = page.locator(`[data-mid="${own.id}"]`).first();
  await row.hover();
  await row.getByRole('button', { name: 'Add to Tasks' }).waitFor();
  if (await row.getByRole('button', { name: /to Drive$/ }).count()) throw new Error('shown on own');
});
await step('📎 Files: Save on Kim’s attachments, not on yours', async () => {
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  const panel = page.getByRole('dialog', { name: 'Files in this conversation' });
  await panel.getByRole('link', { name: 'mine.txt' }).waitFor();
  if (await panel.getByRole('button', { name: 'Save mine.txt to Drive' }).count()) throw new Error('own');
  await panel.getByRole('button', { name: 'Save a.txt to Drive' }).click();
  await page.getByRole('menuitem', { name: 'Save to My Drive' }).click();
  await page.getByText('Saved “a.txt” to My Drive').waitFor();
  const r = await page.evaluate(async () => { const l = await (await fetch('/api/files', { headers: { 'x-requested-with': 'nas-workspace' } })).json(); const a = l.find((x) => x.name === 'a.txt'); return (await fetch(`/api/files/${a.id}/raw`)).text(); });
  if (r !== 'A') throw new Error(r);
});
await step('Save to a folder…: pick Projects; Show in Drive opens the folder', async () => {
  const projects = (await api(page, 'POST', '/files/folder', { name: 'Projects' })).body;
  await page.goto(`${B}/chat/${dm}`);
  const row = page.locator(`[data-mid="${msg.id}"]`).first();
  await row.hover();
  await row.getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByRole('menuitem', { name: 'Save to a folder…' }).click();
  const d = page.getByRole('dialog', { name: 'Save “quote.txt” to Drive' });
  await d.getByLabel('Save in').selectOption({ label: 'Projects' });
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByText('Saved “quote.txt” to Drive').waitFor();
  await page.getByRole('button', { name: 'Show in Drive' }).click();
  await page.waitForURL(`**/drive/folder/${projects.id}`);
  await page.getByText('quote.txt').first().waitFor();
});
await step('the viewer has Save to Drive for Kim’s file, not for yours', async () => {
  await page.goto(`${B}/chat/${dm}`);
  await page.locator(`[data-mid="${msg.id}"]`).first().getByRole('link', { name: /quote\.txt/ }).click();
  const v = page.getByRole('dialog', { name: 'quote.txt' });
  await v.getByRole('button', { name: 'Save to Drive' }).click();
  const d = page.getByRole('dialog', { name: 'Save “quote.txt” to Drive' });
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved “quote (1).txt” to My Drive').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.msg-file', { hasText: 'mine.txt' }).click();
  const own = page.getByRole('dialog', { name: 'mine.txt' });
  await own.getByRole('link', { name: 'Download' }).waitFor();
  if (await own.getByRole('button', { name: 'Save to Drive' }).count()) throw new Error('own');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
