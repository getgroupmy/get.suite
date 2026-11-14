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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
let kim, docId;
const frow = (name) => page.locator('.files tbody tr', { hasText: name }).first();
await step('a file and a document in Drive', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await page.evaluate(async () => fetch('/api/files/upload?name=report.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: 'Quarterly numbers' }));
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' })).body.id;
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
});
await step('a file: ⋮ → Email as attachment opens a new message with it attached; Kim gets it', async () => {
  await page.goto(`${B}/drive`);
  await frow('report.txt').getByRole('button', { name: 'Actions for report.txt' }).click();
  await page.getByRole('menuitem', { name: 'Email as attachment' }).click();
  const d = page.getByRole('dialog', { name: 'report.txt' });
  await d.waitFor({ timeout: 30000 });
  await d.getByText('report.txt', { exact: true }).first().waitFor();
  if (await d.getByLabel('Subject').inputValue() !== 'report.txt') throw new Error('subject');
  await page.screenshot({ path: `${SP}/shots/drive-email.png` });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.locator('.mail-list').getByText('report.txt', { exact: true }).click({ timeout: 40000 });
  await kim.locator('.mail-reader').getByText('report.txt').first().waitFor();
});
await step('a document: it asks what to attach it as first (Word here)', async () => {
  await page.goto(`${B}/drive`);
  await frow('Plan').getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Email as attachment' }).click();
  const as = page.getByRole('dialog', { name: 'Attach “Plan”' });
  await as.getByLabel('Word (.docx)').check({ timeout: 30000 });
  await as.getByRole('button', { name: 'Attach' }).click();
  await as.waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: 'Plan' }).getByText('Plan.docx').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
