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
let kim;
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
let doc;
let lee;
const chip = (p, text) => p.locator('.ProseMirror .doc-chip', { hasText: text });
await step('a Status dropdown goes in from the toolbar and a choice is picked with a click', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const id = (u) => dir.find((x) => x.username === u).id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: id('kim@acme.com'), role: 'editor' }, { user_id: id('lee@acme.com'), role: 'viewer' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Website: ');
  await page.getByRole('button', { name: 'Insert dropdown' }).click();
  await page.getByRole('menuitem', { name: /^Status: Not started/ }).click();
  await chip(page, 'Not started').waitFor();
  if (!(await chip(page, 'Not started').getAttribute('class')).includes('chip-none')) throw new Error('nothing picked yet should look empty');
  await chip(page, 'Not started').click();
  const menu = page.getByRole('listbox', { name: 'Choices' });
  await menu.getByRole('option', { name: 'In progress' }).click();
  await chip(page, 'In progress').waitFor();
  if (!(await chip(page, 'In progress').getAttribute('class')).includes('chip-blue')) throw new Error('colour');
  if (await menu.count()) throw new Error('menu should close');
  await page.keyboard.type('and more text');
  await page.locator('.ProseMirror', { hasText: 'In progress ▾ and more text' }).waitFor();
});
await step('a colleague sees it live and changes it with the keyboard; it changes for everyone', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await chip(kim, 'In progress').click();
  const menu = kim.getByRole('listbox', { name: 'Choices' });
  await menu.waitFor();
  await kim.keyboard.press('ArrowDown');
  await kim.keyboard.press('Enter');
  await chip(kim, 'Blocked').waitFor();
  await chip(page, 'Blocked').waitFor();
  if (!(await chip(page, 'Blocked').getAttribute('class')).includes('chip-red')) throw new Error('colour for Olivia');
});
await step('someone who can only view sees the chip but no choices', async () => {
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/docs/${doc.id}`);
  await chip(lee, 'Blocked').click();
  await lee.waitForTimeout(300);
  if (await lee.getByRole('listbox', { name: 'Choices' }).count()) throw new Error('viewer got a menu');
});
await step('a dropdown with your own choices, changed later; a choice that went is cleared', async () => {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Owner team: ');
  await page.getByRole('button', { name: 'Insert dropdown' }).click();
  await page.getByRole('menuitem', { name: 'Your own choices…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Choice 1', { exact: true }).fill('Design');
  await dlg.getByLabel('Choice 2', { exact: true }).fill('Sales');
  await dlg.getByRole('button', { name: 'Add a choice' }).click();
  await dlg.getByLabel('Choice 3', { exact: true }).fill('Support');
  await dlg.getByLabel('Colour of choice 3').selectOption('purple');
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await chip(page, 'Design').click();
  await page.getByRole('listbox', { name: 'Choices' }).getByRole('option', { name: 'Support' }).click();
  await chip(page, 'Support').waitFor();
  if (!(await chip(page, 'Support').getAttribute('class')).includes('chip-purple')) throw new Error('own colour');
  await chip(page, 'Support').click();
  await page.getByRole('button', { name: 'Change the choices…' }).click();
  await dlg.getByRole('button', { name: 'Remove choice 3' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await chip(page, 'Design').waitFor(); // Support is gone, so nothing is picked
  await chip(kim, 'Design').waitFor();
});
await step('chips read as their choice in the Markdown download', async () => {
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Website: **Blocked**') || !text.includes('Owner team: **Design**')) throw new Error(JSON.stringify(text));
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
