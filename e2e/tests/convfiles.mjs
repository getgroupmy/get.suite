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
let general, doc, up, m1;
await step('files attached and linked in #general', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body;
  up = await page.evaluate(async () => (await fetch('/api/files/upload?name=minutes.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, body: 'Minutes of the meeting' })).json());
  m1 = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'The minutes', files: [up.id] })).body;
  for (let i = 0; i < 25; i++) await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `filler ${i}` });
  await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Plan: ${B}/docs/${doc.id}` });
});
const panel = () => page.getByRole('dialog', { name: 'Files in this conversation' });
await step('📎 lists them, newest first, with who shared each', async () => {
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  await until(async () => (await panel().locator('.conv-file a').allInnerTexts()).join('|') === 'Launch plan|minutes.txt');
  const meta = await panel().locator('.conv-file .muted').allInnerTexts();
  if (!/^Document · Olivia Owner/.test(meta[0]) || !/^22 B · Olivia Owner/.test(meta[1])) throw new Error(meta.join(' / '));
});
await step('find by name', async () => {
  await panel().getByLabel('Find a file by name').fill('MINUT');
  await until(async () => (await panel().locator('.conv-file a').allInnerTexts()).join('|') === 'minutes.txt');
  await panel().getByLabel('Find a file by name').fill('nothing like it');
  await panel().getByText('No file by that name here.').waitFor();
  await panel().getByLabel('Find a file by name').fill('');
});
await step('Show jumps to the message, far up the conversation', async () => {
  await panel().getByRole('button', { name: 'Show minutes.txt in the conversation' }).click();
  await page.waitForURL(`**/chat/${general}?msg=${m1.id}`);
  await until(() => page.locator(`[data-mid="${m1.id}"]`).isVisible());
  if (await panel().count()) throw new Error('panel still open');
});
await step('the attachment opens from its message; a document in Docs', async () => {
  const r = await page.evaluate(async ([m, f]) => (await fetch(`/api/chat/messages/${m}/files/${f}?view`)).text(), [m1.id, up.id]);
  if (r !== 'Minutes of the meeting') throw new Error(r);
  const href = await (async () => { await page.getByRole('button', { name: 'Files in this conversation' }).click(); return panel().getByRole('link', { name: 'minutes.txt' }).getAttribute('href'); })();
  if (href !== `/api/chat/messages/${m1.id}/files/${up.id}?view`) throw new Error(href);
  await panel().getByRole('link', { name: 'Launch plan' }).click();
  await page.waitForURL(`**/docs/${doc.id}`);
});
await step('an empty conversation says how files get there', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  await panel().getByText(/No files yet/).waitFor();
  await page.keyboard.press('Escape');
});
await step('Show on a file linked in a thread reply opens the conversation with that thread', async () => {
  const parent = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Thread start' })).body;
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Thread sheet' })).body;
  const rep = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `/sheets/${sheet.id}`, parent_id: parent.id })).body;
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  await panel().getByRole('button', { name: 'Show Thread sheet in the conversation' }).click();
  await page.waitForURL(`**/chat/${general}?msg=${rep.id}&thread=${parent.id}`);
  await until(() => page.locator(`[data-mid="${rep.id}"]`).first().isVisible());
  if (!(await page.locator(`[data-mid="${parent.id}"]`).first().isVisible())) throw new Error('main list empty');
});
await step('type buttons: Pictures, Documents, PDFs (none), back to All', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pic = await page.evaluate(async (b) => (await fetch('/api/files/upload?name=photo.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/png' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) })).json(), png);
  await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'A photo', files: [pic.id] });
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  const names = () => panel().locator('.conv-file a').allInnerTexts();
  await until(async () => (await names()).includes('photo.png'));
  const types = panel().getByRole('group', { name: 'Type of file' });
  await types.getByRole('button', { name: 'Pictures' }).click();
  await until(async () => (await names()).join('|') === 'photo.png');
  if (await types.getByRole('button', { name: 'Pictures' }).getAttribute('aria-pressed') !== 'true') throw new Error('not pressed');
  await types.getByRole('button', { name: 'Documents' }).click();
  await until(async () => (await names()).sort().join('|') === 'Launch plan|Thread sheet|minutes.txt');
  await types.getByRole('button', { name: 'PDFs' }).click();
  await panel().getByText('No PDFs here.').waitFor();
  await types.getByRole('button', { name: 'All' }).click();
  await until(async () => (await names()).length === 4);
});
await step('phone width: the panel fits', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('button', { name: 'Files in this conversation' }).click();
  await panel().locator('.conv-file a').first().waitFor();
  const b = await panel().boundingBox();
  if (b.x < 0 || b.x + b.width > 390) throw new Error(JSON.stringify(b));
  await page.screenshot({ path: `${SP}/shots/convfiles-phone.png` });
  await page.getByRole('button', { name: 'Close files' }).click();
  await page.getByRole('button', { name: /^Pinned messages/ }).click();
  const p = await page.getByRole('dialog', { name: 'Pinned messages' }).boundingBox();
  if (p.x < 0 || p.x + p.width > 390) throw new Error(`pinned: ${JSON.stringify(p)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
