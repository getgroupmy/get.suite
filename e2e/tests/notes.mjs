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
let kim;
const cardOf = (p, name) => p.getByRole('article', { name });
const notes = async (p, qs = '') => (await api(p, 'GET', `/notes${qs}`)).body;
await step('take a note', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.getByRole('link', { name: 'Notes', exact: true }).first().click();
  await page.getByText('Notes you add appear here').waitFor();
  await page.getByRole('button', { name: 'Take a note…' }).click();
  await page.getByLabel('Title').fill('Plumber');
  await page.getByLabel('Take a note').fill('Call on Monday about the leak');
  await page.getByRole('button', { name: 'Close' }).click();
  await cardOf(page, 'Plumber').waitFor();
});
await step('a checklist; tick an item on the card', async () => {
  await page.getByRole('button', { name: 'New checklist' }).click();
  await page.getByLabel('Title').fill('Shopping');
  await page.getByLabel('List item 1').fill('Milk');
  await page.keyboard.press('Enter');
  await page.getByLabel('List item 2').fill('Bread');
  await page.getByRole('button', { name: 'Close' }).click();
  const c = cardOf(page, 'Shopping');
  await c.getByText('Bread').waitFor();
  await c.getByLabel('Milk').click();
  await c.getByText('1 ticked item').waitFor();
  await until(async () => (await notes(page)).find((n) => n.title === 'Shopping').items.find((i) => i.text === 'Milk').done);
});
await step('pin, colour and label', async () => {
  await cardOf(page, 'Plumber').getByRole('button', { name: 'Pin note' }).click();
  await page.getByRole('heading', { name: 'Pinned' }).waitFor();
  await page.getByLabel('Pinned notes').getByRole('article', { name: 'Plumber' }).waitFor();
  await cardOf(page, 'Shopping').getByRole('button', { name: 'Background colour' }).click();
  await page.getByRole('menuitem', { name: 'Mint' }).click();
  await until(async () => (await notes(page)).find((n) => n.title === 'Shopping').color === '#e2f6d3');
  await cardOf(page, 'Shopping').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Labels…' }).click();
  await page.getByRole('button', { name: '+ New label' }).click();
  await page.getByLabel('Label', { exact: true }).fill('home');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'home', exact: true }).click();
  await cardOf(page, 'Shopping').waitFor();
  await until(async () => (await cardOf(page, 'Plumber').count()) === 0);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
});
await step('open and edit a note', async () => {
  await cardOf(page, 'Plumber').getByText('Call on Monday').click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Note').fill('Call on Tuesday about the leak');
  await d.getByRole('button', { name: 'Close' }).last().click();
  await cardOf(page, 'Plumber').getByText('Call on Tuesday').waitFor();
});
await step('search', async () => {
  await page.getByLabel('Search notes').fill('bread');
  await until(async () => (await page.getByRole('article').count()) === 1);
  await cardOf(page, 'Shopping').waitFor();
  await page.getByLabel('Search notes').fill('');
});
await step('share with a colleague, who edits it live', async () => {
  await cardOf(page, 'Plumber').getByRole('button', { name: 'Share note' }).click();
  await page.getByRole('dialog', { name: 'Share note' }).getByLabel(/Kim Park/).check();
  await page.getByRole('button', { name: 'Save' }).click();
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/notes`);
  await cardOf(kim, 'Plumber').getByText('Call on Tuesday').click();
  await kim.getByRole('dialog').getByLabel('Note').fill('Plumber booked for Wednesday');
  await kim.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await cardOf(page, 'Plumber').getByText('Plumber booked for Wednesday').waitFor();
});
await step('archive with undo', async () => {
  await cardOf(page, 'Shopping').getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Note archived').waitFor();
  await until(async () => !(await notes(page)).some((n) => n.title === 'Shopping'));
  await page.getByRole('button', { name: 'Archive', exact: true }).first().click({ trial: true }).catch(() => {});
  await page.locator('.subnav').getByRole('button', { name: 'Archive' }).click();
  await cardOf(page, 'Shopping').waitFor();
  await page.screenshot({ path: `${SP}/shots/notes.png` });
});
await step('delete goes to the trash, with Undo', async () => {
  await page.getByRole('button', { name: 'Notes', exact: true }).first().click().catch(() => {});
  await cardOf(page, 'Plumber').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await page.getByText('Note moved to the trash').waitFor();
  await until(async () => (await cardOf(page, 'Plumber').count()) === 0);
  await page.locator('.toast', { hasText: 'Note moved to the trash' }).getByRole('button', { name: 'Undo' }).click();
  await cardOf(page, 'Plumber').waitFor();
});
await step('the Trash restores a note, or deletes it for good', async () => {
  await cardOf(page, 'Plumber').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await until(async () => (await cardOf(page, 'Plumber').count()) === 0);
  await page.locator('.subnav').getByRole('button', { name: 'Trash' }).click();
  await page.getByText('deleted for good after 7 days').waitFor();
  await cardOf(page, 'Plumber').getByRole('button', { name: 'Restore' }).click();
  await page.getByText('The trash is empty').waitFor();
  await page.locator('.subnav').getByRole('button', { name: 'Notes', exact: true }).click();
  await cardOf(page, 'Plumber').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await page.locator('.subnav').getByRole('button', { name: 'Trash' }).click();
  await page.screenshot({ path: `${SP}/shots/notestrash.png` });
  await page.getByRole('button', { name: 'Empty trash' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click();
  await page.getByText('The trash is empty').waitFor();
  const all = (await api(page, 'GET', '/notes?trash=1')).body;
  if (all.length) throw new Error('still in trash');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
