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
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, name: "test.acme.com" });
await step('search, then Save this search: it sits in the sidebar with its unread count', async () => {
  for (const n of [1, 2]) await smtp.sendMail({ from: 'Billing <billing@acme.com>', to: 'olivia@acme.com', subject: `Invoice ${n}`, text: 'Pay me' });
  await smtp.sendMail({ from: 'Pat <pat@acme.com>', to: 'olivia@acme.com', subject: 'Lunch?', text: 'x' });
  await refreshUntil(page, inboxRow('Invoice 2'));
  await page.getByLabel('Search mail').fill('from:billing@acme.com');
  await page.getByLabel('Search mail').press('Enter');
  await page.getByText('Results for “from:billing@acme.com”').waitFor();
  await page.getByRole('button', { name: 'Save this search' }).click();
  await page.getByText('Search saved').waitFor();
  const item = page.locator('.subnav-item', { hasText: 'from:billing@acme.com' });
  await item.waitFor();
  await item.locator('.count', { hasText: '2' }).waitFor();
  if (await page.getByRole('button', { name: 'Save this search' }).count()) throw new Error('offered again');
  await page.screenshot({ path: `${SP}/shots/saved-search.png` });
});
await step('clicking it runs it again from anywhere; reading one lowers the count; removing it', async () => {
  await page.getByRole('button', { name: 'Sent' }).first().click();
  await page.locator('.subnav-item', { hasText: 'from:billing@acme.com' }).click();
  await page.getByText('Results for “from:billing@acme.com” in Inbox').waitFor();
  await inboxRow('Invoice 1').click();
  await page.getByRole('heading', { name: 'Invoice 1' }).waitFor();
  await until(async () => (await page.locator('.subnav-item', { hasText: 'from:billing@acme.com' }).locator('.count').innerText().catch(() => '')) === '1', 15000);
  await page.getByRole('button', { name: 'Remove saved search from:billing@acme.com' }).click();
  await until(async () => (await page.locator('.subnav-item', { hasText: 'from:billing@acme.com' }).count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
