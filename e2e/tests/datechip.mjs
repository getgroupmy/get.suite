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
const day = (p, text) => p.locator('.ProseMirror .doc-date', { hasText: text });
const fmt = (d) => `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
const today = new Date(), tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
await step('@tomorrow puts in tomorrow as a chip', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Release plan' })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: dir.find((x) => x.username === 'kim@acme.com').id, role: 'editor' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Code freeze: @tom');
  const list = page.getByRole('listbox', { name: 'People, dates and files' });
  await list.getByRole('option', { name: /Tomorrow/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/datechip-picker.png` });
  await page.keyboard.press('Enter');
  await day(page, fmt(tomorrow)).waitFor();
  await page.keyboard.type('then launch.');
  await page.locator('.ProseMirror', { hasText: `Code freeze: ${fmt(tomorrow)} then launch.` }).waitFor();
});
await step('@date opens the calendar; the day picked is everyone\'s, and past days show red', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('Kick-off: @date');
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Change the date' });
  await menu.waitFor();
  await menu.getByLabel('Date').fill('2026-01-15');
  await menu.getByRole('button', { name: 'Done' }).click();
  await menu.waitFor({ state: 'detached' });
  await day(page, '15 Jan 2026').waitFor();
  if (!(await day(page, '15 Jan 2026').getAttribute('class')).includes('when-past')) throw new Error('past date not marked');
  await page.keyboard.type('done');
  await page.locator('.ProseMirror p', { hasText: 'Kick-off: 15 Jan 2026 done' }).waitFor();
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await day(kim, '15 Jan 2026').waitFor();
  // Kim moves the code freeze to the 20th of next year from its calendar.
  await day(kim, fmt(tomorrow)).click();
  const kmenu = kim.getByRole('dialog', { name: 'Change the date' });
  await kmenu.getByLabel('Date').fill(`${today.getFullYear() + 1}-03-20`);
  await kim.keyboard.press('Enter');
  await day(kim, `20 Mar ${today.getFullYear() + 1}`).waitFor();
  await day(page, `20 Mar ${today.getFullYear() + 1}`).waitFor();
  await page.screenshot({ path: `${SP}/shots/datechip-doc.png` });
});
await step('the toolbar\'s Date puts in today; Today in its calendar sets it back', async () => {
  await page.locator('.ProseMirror p', { hasText: 'Kick-off' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Today: ');
  await page.getByRole('button', { name: 'Insert date' }).click();
  await day(page, fmt(today)).waitFor();
  if (!(await day(page, fmt(today)).getAttribute('class')).includes('when-today')) throw new Error('today');
  await day(page, '15 Jan 2026').click();
  await page.getByRole('dialog', { name: 'Change the date' }).getByRole('button', { name: 'Tomorrow' }).click();
  await until(async () => (await day(page, fmt(tomorrow)).count()) === 1);
});
await step('dates read as words in the Markdown download and are found by search', async () => {
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes(`Code freeze: 20 Mar ${today.getFullYear() + 1} then launch.`) || !text.includes(`Kick-off: ${fmt(tomorrow)} done Today: ${fmt(today)}`)) throw new Error(JSON.stringify(text));
  const found = await until(async () => { const r = await api(page, 'GET', `/files?view=search&q=${today.getFullYear() + 1}-03-20`); return JSON.stringify(r.body).includes('Release plan') && r; });
  if (!found) throw new Error('not found');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
