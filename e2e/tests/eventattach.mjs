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
await step('attach a Drive document to a new event with a guest', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Planning agenda' })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Planning');
  await dlg.getByRole('combobox', { name: 'Guests' }).fill('kim@acme.com');
  await dlg.getByRole('combobox', { name: 'Guests' }).press('Enter');
  await dlg.getByRole('button', { name: 'Attach from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach to the event' });
  await pick.getByLabel('Search your files').fill('agenda');
  await pick.getByRole('button', { name: /Planning agenda/ }).click();
  await pick.waitFor({ state: 'detached' });
  await dlg.getByRole('list', { name: 'Attachments' }).getByRole('link', { name: 'Planning agenda' }).waitFor();
  await dlg.getByText('Guests can view the files you own.', { exact: false }).waitFor();
  await page.screenshot({ path: `${SP}/shots/event-attach.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
});
await step('the guest sees it on the invitation and can open it', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Schedule' }).click();
  await kim.waitForTimeout(1500); await kim.screenshot({ path: SP + '/shots/kimcal.png' });
  await kim.getByText('Planning', { exact: true }).first().click();
  const d = kim.getByRole('dialog', { name: 'Planning' });
  const link = d.getByRole('list', { name: 'Attachments' }).getByRole('link', { name: 'Planning agenda' });
  if ((await link.getAttribute('href')) !== `/docs/${doc.id}`) throw new Error('href');
  if ((await api(kim, 'GET', `/files/${doc.id}`)).status !== 200) throw new Error('kim cannot open it');
}, kim);
await step('removing the attachment', async () => {
  await page.getByText('Planning', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByRole('button', { name: 'Remove Planning agenda' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 864e5 * 7}`)).body;
  if (evs.find((e) => e.title === 'Planning').attachments.length) throw new Error('still attached');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
