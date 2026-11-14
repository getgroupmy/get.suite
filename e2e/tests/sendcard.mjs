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
let dm;
await step('Kim sends Olivia’s company contact and Lee’s card from the Directory', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  await api(page, 'POST', '/contacts', { name: 'Supplier Sue', email: 'sue@supply.example', shared: true });
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Company' }).click();
  await kim.getByRole('button', { name: 'Send Supplier Sue in Chat' }).click();
  let d = kim.getByRole('dialog', { name: 'Send Supplier Sue in Chat' });
  await d.getByLabel('To').selectOption({ label: 'Olivia Owner' });
  await d.getByRole('button', { name: 'Send' }).click();
  await kim.getByText('Supplier Sue sent to Olivia Owner').waitFor();
  await kim.getByRole('tab', { name: 'Directory' }).click();
  await kim.getByRole('button', { name: "Send Lee Chan's card in Chat" }).click();
  d = kim.getByRole('dialog', { name: 'Send Lee Chan in Chat' });
  await d.getByText('their name, address, job title').waitFor();
  await d.getByLabel('To').selectOption({ label: 'Olivia Owner' });
  await d.getByRole('button', { name: 'Send' }).click();
  await kim.getByText('Lee Chan sent to Olivia Owner').waitFor();
});
await step('Olivia sees both cards and adds Lee', async () => {
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('group', { name: 'Contact: Supplier Sue' }).waitFor();
  const lee = page.getByRole('group', { name: 'Contact: Lee Chan' });
  await lee.getByText('lee@acme.com').waitFor();
  await lee.getByRole('button', { name: 'Add to my contacts' }).click();
  await page.getByText('Lee Chan added to your contacts').waitFor();
  const mine = (await api(page, 'GET', '/contacts')).body;
  if (!mine.some((c) => c.email === 'lee@acme.com')) throw new Error('not added');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
