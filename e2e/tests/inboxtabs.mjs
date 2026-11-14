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
await step('newsletters and notifications go to Updates, people to Primary', async () => {
  await smtp.sendMail({ from: 'Pat <pat@acme.com>', to: 'olivia@acme.com', subject: 'Lunch on Friday?', text: 'Shall we?' });
  await smtp.sendMail({ from: 'Acme Shop <shop@acme.com>', to: 'olivia@acme.com', subject: 'Autumn sale: 30% off', text: 'Deals', headers: { 'List-Unsubscribe': '<mailto:unsub@acme.com>' } });
  await smtp.sendMail({ from: 'Builds <ci@acme.com>', to: 'olivia@acme.com', subject: 'Build 512 passed', text: 'ok', headers: { 'Auto-Submitted': 'auto-generated' } });
  const tabs = page.getByRole('tablist', { name: 'Inbox tabs' });
  await tabs.waitFor();
  await refreshUntil(page, inboxRow('Lunch on Friday?'));
  await tabs.getByRole('tab', { name: /Updates.*2/ }).waitFor({ timeout: 15000 });
  if (await inboxRow('Autumn sale: 30% off').count()) throw new Error('newsletter in Primary');
  await page.screenshot({ path: `${SP}/shots/inbox-tabs.png` });
  await tabs.getByRole('tab', { name: /Updates/ }).click();
  await inboxRow('Autumn sale: 30% off').waitFor();
  await inboxRow('Build 512 passed').waitFor();
  if (await inboxRow('Lunch on Friday?').count()) throw new Error('a person in Updates');
  await tabs.getByRole('tab', { name: /Primary.*1/ }).waitFor();
});
await step('one picked to be read moves to Primary and stays there', async () => {
  await page.getByRole('checkbox', { name: 'Select Build 512 passed' }).check();
  await page.getByRole('button', { name: 'Move to Primary' }).click();
  await page.getByText('Moved to Primary').waitFor();
  await until(async () => (await inboxRow('Build 512 passed').count()) === 0);
  await page.getByRole('tablist', { name: 'Inbox tabs' }).getByRole('tab', { name: /Primary/ }).click();
  await inboxRow('Build 512 passed').waitFor();
  await inboxRow('Lunch on Friday?').waitFor();
});
await step('turned off in Filters: one Inbox again', async () => {
  await page.getByRole('button', { name: /Filters/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Filters' });
  await dlg.getByRole('checkbox', { name: /Split the Inbox/ }).uncheck();
  await page.getByText('One Inbox again').waitFor();
  await dlg.getByRole('button', { name: 'Close' }).click();
  await until(async () => (await page.getByRole('tablist', { name: 'Inbox tabs' }).count()) === 0);
  await inboxRow('Autumn sale: 30% off').waitFor();
  await inboxRow('Lunch on Friday?').waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
