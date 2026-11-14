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
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|429|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let doc;
await step('Kim sees what is waiting for her signature on Home and in Drive → Signatures', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Supplier NDA' })).body;
  const r = await api(page, 'POST', '/signatures', { file_id: doc.id, signers: ['kim@acme.com'], message: 'Before Monday' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await kim.goto(`${B}/home`);
  await kim.getByRole('region', { name: 'Waiting for your signature' }).getByRole('link', { name: 'Supplier NDA' }).waitFor();
  await kim.goto(`${B}/drive/signatures`);
  await kim.getByRole('link', { name: /Signatures/ }).getByLabel('1 waiting for your signature').waitFor();
  const w = kim.getByRole('region', { name: 'Waiting for your signature' });
  await w.getByText('Supplier NDA').waitFor();
  await w.getByText(/“Before Monday”/).waitFor();
  await w.getByRole('link', { name: 'Sign' }).click();
  await kim.getByLabel('Your full name').waitFor();
}, kim);
await step('Olivia sees it sent, waiting for Kim, and reminds her once', async () => {
  await page.goto(`${B}/drive/signatures`);
  const s = page.getByRole('region', { name: 'Sent for signature' });
  await s.getByText(/0 of 1 signed · waiting for kim@acme.com/).waitFor();
  await s.getByRole('button', { name: 'Remind' }).click();
  await page.getByText('Reminded 1 person').waitFor();
  await s.getByRole('button', { name: 'Remind' }).click();
  await page.getByText('A reminder was sent less than an hour ago').waitFor();
  await until(async () => (await api(kim, 'GET', '/notifications')).body.items.some((n) => /Reminder: .* is waiting for you to sign “Supplier NDA”/.test(n.title)));
});
await step('once signed, it leaves Kim\'s list and shows as signed for Olivia', async () => {
  await kim.getByLabel('Your full name').fill('Kim Park');
  await kim.getByRole('tab', { name: 'Type' }).click();
  await kim.getByLabel(/I agree to sign/).check();
  await kim.getByRole('button', { name: 'Sign', exact: true }).click();
  await kim.getByText(/You signed this/).waitFor();
  await page.getByRole('region', { name: 'Sent for signature' }).getByText(/signed by everyone/).waitFor();
  await kim.goto(`${B}/drive/signatures`);
  await kim.getByText('Nothing to sign.').waitFor();
});
await step('Kim declines with a reason: Olivia sees it on the document, which is unlocked', async () => {
  const d3 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Offer letter' })).body;
  await api(page, 'POST', '/signatures', { file_id: d3.id, signers: ['kim@acme.com'] });
  const w = await until(async () => (await api(kim, 'GET', '/signatures')).body.waiting.find((x) => x.title === 'Offer letter'));
  await kim.goto(`${B}${w.link}`);
  await kim.getByRole('button', { name: 'Decline to sign…' }).click();
  await kim.getByLabel(/Why\?/).fill('The start date is wrong');
  await kim.getByRole('button', { name: 'Decline', exact: true }).click();
  await kim.getByText(/Declined.*The start date is wrong/).waitFor();
  await page.goto(`${B}/docs/${d3.id}`);
  await page.getByRole('region', { name: 'Signatures' }).getByText(/Declined.*by Kim Park.*The start date is wrong/).waitFor();
  if (await page.getByRole('region', { name: 'Locked' }).count()) throw new Error('still locked');
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
