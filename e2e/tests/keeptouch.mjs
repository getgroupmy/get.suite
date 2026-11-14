import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
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
await step('choose how often to keep in touch; due people are listed; ✓ In touch clears them', async () => {
  await api(page, 'POST', '/contacts', { name: 'Rita Moreno', email: 'rita@moreno.example' });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Edit Rita Moreno' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit contact' });
  await dlg.getByLabel('Keep in touch').selectOption({ label: 'Every month' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Keep in touch' }).click();
  const list = page.getByRole('list', { name: 'Keep in touch' });
  await list.getByText('Rita Moreno').waitFor();
  await list.getByText(/Last in touch: never · every month/).waitFor();
  await page.screenshot({ path: `${SP}/shots/keep-in-touch.png` });
  await list.getByRole('button', { name: 'In touch with Rita Moreno' }).click();
  await page.getByText('Nobody to catch up with').waitFor();
});
await step('Home shows who is due; its link opens the Keep in touch tab; ✓ clears one', async () => {
  for (const n of ['Bo Chan', 'Cy Lee']) { const c = (await api(page, 'POST', '/contacts', { name: n })).body; await api(page, 'PATCH', `/contacts/${c.id}`, { touch_days: 14 }); }
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Keep in touch' });
  await card.getByText('Bo Chan').waitFor();
  await card.getByText(/last in touch never/).first().waitFor();
  await card.getByRole('button', { name: 'In touch with Bo Chan' }).click();
  await until(async () => !(await card.getByText('Bo Chan').count()));
  await card.getByRole('link', { name: /Keep in touch/ }).click();
  await page.getByRole('tab', { name: 'Keep in touch', selected: true }).waitFor();
  await page.getByRole('list', { name: 'Keep in touch' }).getByText('Cy Lee').waitFor();
});
await step('the bell can be told about it, and its link opens the tab even from Contacts', async () => {
  const kinds = (await api(page, 'GET', '/notifications/settings')).body;
  if (!JSON.stringify(kinds).includes('keep in touch')) throw new Error(JSON.stringify(kinds).slice(0, 300));
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'My contacts', selected: true }).waitFor();
  await page.evaluate(() => { history.pushState({}, '', '/contacts?tab=touch'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByRole('tab', { name: 'Keep in touch', selected: true }).waitFor();
});
await step('log a call with a contact: it shows in their history and takes them off Keep in touch', async () => {
  const c = (await api(page, 'POST', '/contacts', { name: 'Dee Logged' })).body;
  await api(page, 'PATCH', `/contacts/${c.id}`, { touch_days: 30 });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'History with Dee Logged' }).click();
  const dlg = page.getByRole('dialog', { name: 'With Dee Logged' });
  await dlg.getByLabel('What happened').fill('Talked about the renewal');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText('Talked about the renewal').waitFor();
  await page.screenshot({ path: `${SP}/shots/contact-log.png` });
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('tab', { name: 'Keep in touch' }).click();
  await page.waitForTimeout(500);
  if (await page.getByRole('list', { name: 'Keep in touch' }).getByText('Dee Logged').count()) throw new Error('still due');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
