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
await step('Send & archive on a reply: the reply goes and the message leaves the Inbox', async () => {
  await page.evaluate(() => fetch('/api/users', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ local: 'raj', domain: 'acme.com', name: 'Raj Kumar', password: 'password123' }) }));
  await page.waitForTimeout(5000); // the mail server learns the new mailbox
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Invoice question', text: 'Can you confirm the total?' });
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Lunch?', text: 'Friday?' });
  await refreshUntil(page, inboxRow('Invoice question'));
  await inboxRow('Invoice question').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Confirmed, 120 EUR.');
  await page.screenshot({ path: `${SP}/shots/sendarchive.png` });
  await page.getByRole('button', { name: 'Send & archive' }).click();
  await page.getByText(/Sent to 1 recipient and archived/).waitFor({ timeout: 20000 }).catch(async (e) => { console.log('DBG toasts', await page.locator('.toast').allInnerTexts()); throw e; });
  await page.locator('.folder-row').getByText('Inbox', { exact: true }).click();
  await refreshUntil(page, inboxRow('Lunch?'));
  await until(async () => (await inboxRow('Invoice question').count()) === 0);
  await page.locator('.folder-row').getByText('Archive', { exact: true }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Invoice question'));
});
await step('a new message has no Send & archive; a plain reply keeps the message in the Inbox', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Send & archive' }).count()) throw new Error('only for replies');
  await page.getByRole('button', { name: /Discard|Close/ }).first().click().catch(() => page.keyboard.press('Escape'));
  await page.locator('.folder-row').getByText('Inbox', { exact: true }).click();
  await refreshUntil(page, inboxRow('Lunch?'));
  await inboxRow('Lunch?').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Yes!');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/^Sent to 1 recipient$/).waitFor({ timeout: 20000 });
  await page.locator('.folder-row').getByText('Inbox', { exact: true }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Lunch?'));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
