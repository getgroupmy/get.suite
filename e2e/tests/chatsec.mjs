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
let ch, kim;
const side = (p) => p.locator('aside.subnav');
await step('make a section from a conversation, and its conversations move there', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'acme-client' })).body.id;
  await page.goto(`${B}/chat/${ch}`);
  await page.getByLabel('Section', { exact: true }).selectOption('__new__');
  const dlg = page.getByRole('dialog', { name: 'New section' });
  await dlg.getByLabel('Section name').fill('Clients');
  await dlg.getByRole('button', { name: 'Add' }).click();
  const sec = page.getByRole('list', { name: 'Section Clients' });
  await sec.getByRole('button', { name: /acme-client/ }).waitFor();
  // Not in Channels any more (only once in the sidebar).
  if ((await page.locator('aside.subnav').getByRole('button', { name: /^#\s*acme-client/ }).count()) !== 1) throw new Error('shown twice');
  // general joins it too, from its header.
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Section', { exact: true }).selectOption({ label: 'Clients' });
  await sec.getByRole('button', { name: /general/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-sections.png` });
  await page.reload();
  await page.getByRole('list', { name: 'Section Clients' }).getByRole('button', { name: /general/ }).waitFor();
});
await step('fold a section away: read conversations hide, and it stays folded after a reload', async () => {
  await api(page, 'POST', '/chat/read-all', {});
  await page.goto(`${B}/chat`);
  const sec = page.getByRole('list', { name: 'Section Clients' });
  await sec.getByRole('button', { name: /general/ }).waitFor();
  await page.locator('.chat-section-fold', { hasText: 'Clients' }).click();
  // The open conversation stays; the other (read) one hides.
  await until(async () => !(await sec.getByRole('button', { name: /general/ }).count()));
  await sec.getByRole('button', { name: '1 more' }).waitFor();
  await page.reload();
  await page.getByRole('list', { name: 'Section Clients' }).getByRole('button', { name: '1 more' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-section-folded.png` });
  await page.locator('.chat-section-fold', { hasText: 'Clients' }).click();
  await page.getByRole('list', { name: 'Section Clients' }).getByRole('button', { name: /general/ }).waitFor();
});
await step('rename and delete a section: its conversations go back', async () => {
  await page.getByRole('button', { name: 'Section actions: Clients' }).click();
  await page.getByRole('menuitem', { name: 'Rename section…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename section' });
  await dlg.getByLabel('Section name').fill('Customers');
  await dlg.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('list', { name: 'Section Customers' }).waitFor();
  await page.getByRole('button', { name: 'Section actions: Customers' }).click();
  await page.getByRole('menuitem', { name: 'Delete section' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete section' }).click();
  await until(async () => !(await page.getByRole('list', { name: 'Section Customers' }).count()));
  await page.locator('aside.subnav').getByRole('button', { name: /^#\s*acme-client/ }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
