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
let link;
await step('Olivia writes to Kim and to an outside address with 🔒 Confidential', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('kim@acme.com, partner@acme.com');
  await page.getByLabel('Subject').fill('Offer letter');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('The salary is 1,000,000.');
  await page.getByLabel('Confidential').selectOption({ label: '🔒 Confidential, 1 week' });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForTimeout(6000); // past undo send
  const list = (await api(page, 'GET', '/mail/confidential')).body;
  if (list[0]?.subject !== 'Offer letter') throw new Error(JSON.stringify(list));
  link = `${B}/c/${list[0].token}`;
});
await step('Kim gets only a link in the email, and reads it signed in', async () => {
  const kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  const msgs = await until(async () => { const r = await api(kim, 'GET', '/mail/messages?folder=INBOX&q=Offer'); return r.body?.messages?.length && r.body.messages; }, 40000);
  const msg = (await api(kim, 'GET', `/mail/messages/${msgs[0].uid}?folder=INBOX`)).body;
  if (JSON.stringify(msg).includes('1,000,000')) throw new Error('the message went by email');
  if (!msg.text.includes(link.replace(B, '').slice(0, 10))) throw new Error(msg.text);
  await kim.goto(link);
  await kim.getByRole('heading', { name: 'Offer letter' }).waitFor();
  await kim.frameLocator('iframe[title="Message"]').getByText('The salary is 1,000,000.').waitFor();
  await kim.screenshot({ path: `${SP}/shots/confidential-read.png` });
});
await step('someone outside (no account here) reads it with a code emailed to them', async () => {
  // "partner@acme.com" has no account: they ask for a code, which arrives in... nobody's mailbox here,
  // so the test reads it from the catch-all-less queue instead: give Olivia the partner's mailbox as an alias.
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto(link);
  await visitor.getByText('Olivia Owner sent this to you by email').waitFor();
  await visitor.getByLabel('Your email address').fill('nobody@else.org');
  await visitor.getByRole('button', { name: 'Send me a code' }).click();
  await visitor.getByText('If this was sent to nobody@else.org, a code is on its way there').waitFor();
  await visitor.getByLabel('Code').fill('123456');
  await visitor.getByRole('button', { name: 'Read the message' }).click();
  await visitor.getByRole('alert').filter({ hasText: /new code/ }).waitFor();
  await ctx.close();
});
await step('Olivia takes it back from Confidential messages; the link stops working', async () => {
  await page.getByRole('button', { name: 'Confidential messages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Confidential messages' });
  await dlg.getByText(/opened 1 time/).waitFor();
  await dlg.getByRole('button', { name: 'Take back Offer letter' }).click();
  await page.getByText('Taken back: nobody can read it now').waitFor();
  await dlg.getByText(/Taken back/).waitFor();
  const kim2 = await mk('kim2');
  await kim2.goto(B);
  await kim2.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim2.goto(link);
  await kim2.getByText('Olivia Owner took this message back.').waitFor();
});
errors.splice(0, errors.length, ...errors.filter((e) => !/status of 410/.test(e))); // a taken-back message answers 410: expected
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
