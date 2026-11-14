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
const trash = async () => (await api(page, 'GET', '/contacts/trash')).body.contacts;
const mine = async () => (await api(page, 'GET', '/contacts')).body;
const tab = (n) => page.getByRole('tab', { name: n });
await step('delete a contact: Undo puts it straight back', async () => {
  for (const [name, email] of [['Pat Plumber', 'pat@plumb.example'], ['Dee Decorator', 'dee@deco.example'], ['Eli Electric', 'eli@sparks.example']]) await api(page, 'POST', '/contacts', { name, email, phone: '0123' });
  await page.goto(`${B}/contacts`);
  await page.getByText('Pat Plumber').waitFor();
  await page.getByRole('button', { name: 'Delete Pat Plumber' }).click();
  await page.getByRole('dialog').getByText('It goes to Trash for 30 days.').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).click();
  await page.locator('.toast', { hasText: 'Pat Plumber moved to Trash' }).getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Contact put back').waitFor();
  await until(async () => (await mine()).some((c) => c.name === 'Pat Plumber' && c.phone === '0123'));
  if ((await trash()).length) throw new Error('left in trash');
});
await step('delete several; the Trash tab lists them, Restore puts one back', async () => {
  await page.getByLabel('Select Dee Decorator').check();
  await page.getByLabel('Select Eli Electric').check();
  await page.getByRole('toolbar', { name: 'Change the selected contacts' }).getByRole('button', { name: /Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.toast', { hasText: '2 contacts moved to Trash' }).waitFor();
  await tab('Trash').click();
  await page.getByText('Deleted contacts are kept 30 days').waitFor();
  await page.getByRole('row', { name: /Dee Decorator/ }).getByText(/gone in 30 days/).waitFor();
  await page.screenshot({ path: `${SP}/shots/contacttrash.png` });
  await page.getByRole('row', { name: /Dee Decorator/ }).getByRole('button', { name: 'Restore' }).click();
  await page.getByText('Dee Decorator put back').waitFor();
  await until(async () => (await mine()).some((c) => c.name === 'Dee Decorator'));
  await tab('My contacts').click();
  await page.getByRole('row', { name: /Dee Decorator/ }).waitFor();
});
await step('delete one for good, then Empty trash', async () => {
  await api(page, 'DELETE', `/contacts/${(await mine()).find((c) => c.name === 'Pat Plumber').id}`);
  await tab('Trash').click();
  await page.getByRole('button', { name: 'Delete Eli Electric for good' }).click();
  await page.getByText('Eli Electric deleted for good').waitFor();
  await page.getByRole('button', { name: 'Empty trash' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete for good' }).click();
  await page.getByText('Trash is empty').waitFor();
  if ((await trash()).length) throw new Error('not empty');
  if ((await mine()).some((c) => c.name === 'Pat Plumber' || c.name === 'Eli Electric')) throw new Error('came back');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
