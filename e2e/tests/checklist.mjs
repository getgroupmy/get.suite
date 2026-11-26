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
let noteId;
const cardOf = (p, name) => p.getByRole('article', { name, exact: true });
const items = async () => (await api(page, 'GET', '/notes')).body.find((n) => n.id === noteId).items.map((i) => `${i.indent ? '>' : ''}${i.text}${i.done ? '*' : ''}`).join(' ');
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
  noteId = (await api(page, 'POST', '/notes', { title: 'Trip', items: ['Pack', 'Socks', 'Charger', 'Book train'].map((text) => ({ text })) })).body.id;
  await page.goto(`${B}/notes`);
  await cardOf(page, 'Trip').waitFor();
});
await step('Tab makes sub-items; Alt+↑ moves an item with its sub-items', async () => {
  await cardOf(page, 'Trip').locator('.note-open').click();
  const dlg = page.getByRole('dialog', { name: 'Trip' });
  await dlg.getByLabel('List item 2', { exact: true }).press('Tab');
  await dlg.getByLabel('List item 3', { exact: true }).press('Tab');
  await dlg.getByLabel('List item 2 (sub-item)').waitFor();
  await dlg.getByLabel('List item 4', { exact: true }).press('Alt+ArrowUp');
  await until(async () => (await dlg.locator('input[aria-label^="List item 1"]').inputValue()) === 'Book train');
  await dlg.getByLabel('List item 2', { exact: true }).press('Enter'); // after Pack: a new main item
  await page.keyboard.type('Passport');
  await page.keyboard.press('Shift+Tab'); // already a main item: nothing happens
  await page.screenshot({ path: `${SP}/shots/checklist-edit.png` });
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await until(async () => (await items()) === 'Book train Pack Passport >Socks >Charger');
});
await step('Alt+↑ on a main item takes its sub-items along; ticking it ticks them', async () => {
  await cardOf(page, 'Trip').locator('.note-open').click();
  const dlg = page.getByRole('dialog', { name: 'Trip' });
  await dlg.getByLabel('List item 3', { exact: true }).press('Alt+ArrowUp'); // Passport, with Socks and Charger, above Pack
  await until(async () => (await dlg.locator('input[aria-label^="List item 5"]').inputValue()) === 'Pack');
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await until(async () => (await items()) === 'Book train Passport >Socks >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Passport').click();
  await until(async () => (await items()) === 'Book train Passport* >Socks* >Charger* Pack');
});
await step('⋮ → Untick all, then Delete ticked items', async () => {
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Untick all items' }).click();
  await until(async () => (await items()) === 'Book train Passport >Socks >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Socks').click();
  await until(async () => (await items()) === 'Book train Passport >Socks* >Charger Pack');
  await cardOf(page, 'Trip').getByLabel('Book train').click();
  await until(async () => (await items()) === 'Book train* Passport >Socks* >Charger Pack');
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete ticked items (2)' }).click();
  await until(async () => (await items()) === 'Passport >Charger Pack');
  await page.screenshot({ path: `${SP}/shots/checklist-card.png` });
});
await step('Copy to Tasks: sub-items become steps', async () => {
  await cardOf(page, 'Trip').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy unticked items to Tasks' }).click();
  await page.locator('.toast', { hasText: '2 tasks added to My tasks' }).waitFor();
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const tasks = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const pp = tasks.find((t) => t.title === 'Passport');
  if (pp?.steps?.map((s) => s.title).join() !== 'Charger' || !tasks.some((t) => t.title === 'Pack')) throw new Error(JSON.stringify(tasks));
});
await step('⋮ → Sort items A–Z: sub-items stay under their item, sorted too; ticks kept', async () => {
  const n = (await api(page, 'POST', '/notes', { title: 'Shopping', items: [{ text: 'pears' }, { text: 'ripe', indent: 1 }, { text: 'green', indent: 1 }, { text: 'Apples', done: true }, { text: 'bread 10' }, { text: 'bread 2' }] })).body;
  await page.goto(`${B}/notes`);
  await cardOf(page, 'Shopping').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Sort items A–Z' }).click();
  const got = async () => (await api(page, 'GET', '/notes')).body.find((x) => x.id === n.id).items.map((i) => `${i.indent ? '>' : ''}${i.text}${i.done ? '*' : ''}`).join('|');
  await until(async () => (await got()) === 'Apples*|bread 2|bread 10|pears|>green|>ripe');
});
await step('a shared note: a comment written in it, listed, and counted on its card', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const n = (await api(page, 'POST', '/notes', { title: 'Offsite', body: 'Where shall we go?' })).body;
  await api(page, 'PUT', `/notes/${n.id}/shares`, { user_ids: [kim.id] });
  await page.goto(`${B}/notes`);
  await cardOf(page, 'Offsite').locator('.note-open').click();
  const dlg = page.getByRole('dialog', { name: 'Offsite' });
  const box = dlg.getByRole('region', { name: 'Comments' });
  await box.getByLabel('Write a comment').fill('The lake house is free');
  await box.getByRole('button', { name: 'Comment' }).click();
  await box.getByText('The lake house is free').waitFor();
  await box.getByText('Comments (1)').waitFor();
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await cardOf(page, 'Offsite').getByLabel('1 comment').waitFor();
});
await step('Download (.zip) of the shared note: its comment is in the Markdown, after a marker', async () => {
  await cardOf(page, 'Offsite').hover();
  await page.getByRole('button', { name: 'Select note: Offsite' }).click();
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await bar.getByText('1 selected').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download (.zip)' }).click()]);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()));
  const md = await zip.file('Offsite.md').async('string');
  if (!/Where shall we go\?\n\n<!-- comments: not part of the note -->\n## Comments\n\n- \*\*Olivia[^*]*\*\* \(.+ UTC\): The lake house is free\n$/.test(md)) throw new Error(md);
  await page.keyboard.press('Escape');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
