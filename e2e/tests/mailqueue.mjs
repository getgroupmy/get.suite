import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
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
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const sub = nodemailer.createTransport({ host: '127.0.0.1', port: 465, secure: true, tls: { rejectUnauthorized: false }, auth: { user: 'olivia@acme.com', pass: 'password123' } });
const row = () => page.getByRole('list', { name: 'Waiting to go out' }).getByRole('listitem', { name: /client@\[192\.0\.2\.10\]/ }).first();
await step('mail that can’t go out shows in the queue, with why', async () => {
  await sub.sendMail({ from: 'olivia@acme.com', to: 'client@[192.0.2.10]', subject: 'Stuck quote', text: 'Will not arrive.' });
  await until(async () => (await api(page, 'GET', '/orgs/system/mail-queue')).body.messages?.some((m) => m.queue === 'deferred'), 30000);
  await page.goto(`${B}/admin?tab=system`);
  await row().getByText(/192\.0\.2\.10.*(No route|timed out|unreachable|refused)/i).waitFor();
  await row().getByText(/from olivia@acme\.com/).waitFor();
  await page.getByRole('list', { name: 'Checks' }).getByRole('listitem', { name: 'Outgoing mail' }).getByText(/1 message waiting/).waitFor();
});
await step('Retry asks the mail server; it stays, still unreachable', async () => {
  await row().getByRole('button', { name: 'Retry' }).click();
  await page.getByText('Asking the mail server…').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await until(async () => (await row().getByRole('button', { name: 'Retry' }).isEnabled()), 15000);
  await row().waitFor();
});
await step('Delete (confirmed) removes it for good', async () => {
  await row().getByRole('button', { name: /^Delete message to/ }).click();
  await page.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Nothing waiting to go out.').waitFor({ timeout: 20000 });
  await page.getByRole('list', { name: 'Checks' }).getByRole('listitem', { name: 'Outgoing mail' }).getByText('Nothing waiting to go out').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
