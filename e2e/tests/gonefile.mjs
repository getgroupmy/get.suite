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
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${n}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, body: t })).json(), [name, text]);
let dm, msg, f1, f2;
await step('Kim sends two files, then trashes one', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await signIn(kim, 'kim@acme.com');
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  f1 = await upload(kim, 'old.txt', 'old'); f2 = await upload(kim, 'new.txt', 'new');
  msg = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'Files', files: [f1.id, f2.id] })).body;
  await api(kim, 'PATCH', `/files/${f1.id}`, { trashed: true });
});
const row = () => page.locator(`[data-mid="${msg.id}"]`).first();
await step('the trashed one says it is no longer available, and is not a link', async () => {
  await page.goto(`${B}/chat/${dm}`);
  await row().locator('.msg-file.gone', { hasText: 'old.txt' }).getByText('no longer available').waitFor();
  if (await row().getByRole('link', { name: /old\.txt/ }).count()) throw new Error('still a link');
  await row().getByRole('link', { name: /new\.txt/ }).waitFor();
});
await step('Save to Drive offers only the one still there', async () => {
  await row().hover();
  await row().getByRole('button', { name: 'Save to Drive' }).click();
  const items = await page.getByRole('menuitem').allInnerTexts();
  if (items.map((x) => x.trim()).join('|') !== 'Save to My Drive|Save to a folder…') throw new Error(items.join('|'));
  await page.getByRole('menuitem', { name: 'Save to My Drive' }).click();
  await page.getByText('Saved “new.txt” to My Drive').waitFor();
});
await step('the viewer steps only through what is still there', async () => {
  await row().getByRole('link', { name: /new\.txt/ }).click();
  const v = page.getByRole('dialog', { name: 'new.txt' });
  await v.waitFor();
  if (await v.getByRole('button', { name: 'Next file' }).count()) throw new Error('arrows for one file');
  await page.keyboard.press('Escape');
});
await step('both gone: no Save to Drive at all', async () => {
  await api(kim, 'PATCH', `/files/${f2.id}`, { trashed: true });
  await page.reload();
  await row().locator('.msg-file.gone').nth(1).waitFor();
  await row().hover();
  await row().getByRole('button', { name: 'Add to Tasks' }).waitFor();
  if (await row().getByRole('button', { name: 'Save to Drive' }).count()) throw new Error('shown');
});
await step('live, without reloading: restored comes back, trashed again goes', async () => {
  await api(kim, 'PATCH', `/files/${f2.id}`, { trashed: false });
  await row().getByRole('link', { name: /new\.txt/ }).waitFor({ timeout: 5000 });
  await api(kim, 'PATCH', `/files/${f2.id}`, { trashed: true });
  await row().locator('.msg-file.gone', { hasText: 'new.txt' }).waitFor({ timeout: 5000 });
});
await step('live in an open thread too', async () => {
  const f3 = await upload(kim, 'thread.txt', 't');
  const rep = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'in thread', parent_id: msg.id, files: [f3.id] })).body;
  await page.goto(`${B}/chat/${dm}?msg=${rep.id}&thread=${msg.id}`);
  const panel = page.locator(`[data-mid="${rep.id}"]`).last();
  await panel.getByRole('link', { name: /thread\.txt/ }).waitFor();
  await api(kim, 'PATCH', `/files/${f3.id}`, { trashed: true });
  await panel.locator('.msg-file.gone', { hasText: 'thread.txt' }).waitFor({ timeout: 5000 });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
