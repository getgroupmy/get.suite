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
let general;
const sendFrom = async (path, name, what) => {
  await page.goto(`${B}${path}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send in Chat…' }).click();
  const d = page.getByRole('dialog', { name: `Send ${what} in Chat` });
  await d.getByLabel('Conversation').selectOption({ label: '# general' });
  await d.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(`**/chat/${general}`);
  const box = page.getByLabel('Message', { exact: true });
  await until(async () => (await box.inputValue()).includes(path));
  if (!(await box.inputValue()).startsWith(`${name}: `)) throw new Error(await box.inputValue());
  await box.press('Enter');
};
await step('a document: ⋮ → Send in Chat… puts its link in #general; it shows as a card', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body;
  await sendFrom(`/docs/${doc.id}`, 'Launch plan', 'the document');
  await page.getByRole('link', { name: 'Document: Launch plan' }).waitFor();
});
await step('a spreadsheet and a presentation too', async () => {
  const sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget' })).body;
  await sendFrom(`/sheets/${sheet.id}`, 'Budget', 'the spreadsheet');
  await page.getByRole('link', { name: 'Spreadsheet: Budget' }).waitFor();
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body;
  await sendFrom(`/slides/${deck.id}`, 'Pitch', 'the presentation');
  await page.getByRole('link', { name: 'Presentation: Pitch' }).waitFor();
});
await step('Chat with people who have access: not yet shared says so; shared with Kim, its own channel', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract notes' })).body;
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Contract notes').click();
  await page.getByRole('menuitem', { name: 'Chat with people who have access' }).click();
  await page.getByText('Share it with someone first').waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Chat with people who have access' }).click();
  await page.waitForURL(/\/chat\/[\w-]+$/);
  const chanId = page.url().split('/chat/')[1];
  await page.getByText('A channel for it, with everyone it’s shared with').waitFor();
  await page.getByRole('link', { name: 'Document: Contract notes' }).first().waitFor();
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  if (!(await api(kim, 'GET', '/chat/channels')).body.channels.some((c) => c.id === chanId)) throw new Error('Kim not in it');
});
await step('its document goes to the trash: the channel says so and doesn’t link to it', async () => {
  const chan = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.about_kind === 'file' && c.about_title === 'Contract notes');
  const doc = (await api(page, 'GET', '/files?view=mine')).body.find((f) => f.name === 'Contract notes');
  await api(page, 'PATCH', `/files/${doc.id}`, { trashed: true });
  await page.goto(`${B}/chat/${chan.id}`);
  await page.getByText('Contract notes · this channel’s file, deleted or in the trash').waitFor();
  if (await page.locator('.chat-topic a').count()) throw new Error('still a link');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
