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
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
await step('a newsletter with an unsubscribe address shows Unsubscribe beside the sender', async () => {
  await smtp.sendMail({ from: 'Weekly News <news@acme.com>', to: 'olivia@acme.com', subject: 'Weekly news 45', text: 'Big week.', headers: { 'List-Unsubscribe': '<mailto:olivia@acme.com?subject=Please%20unsubscribe%20me>' } });
  await smtp.sendMail({ from: 'Shop <shop@acme.com>', to: 'olivia@acme.com', subject: 'Deals inside', text: 'Cheap.', headers: { 'List-Unsubscribe': '<https://shop.example/leave?u=1>' } });
  await page.getByRole('tablist', { name: 'Inbox tabs' }).getByRole('tab', { name: /Updates/ }).click(); // newsletters are in Updates
  await refreshUntil(page, inboxRow('Weekly news 45'));
  await inboxRow('Weekly news 45').click();
  await page.locator('.reader-head').getByRole('button', { name: 'Unsubscribe' }).click();
  const dlg = page.getByRole('dialog', { name: 'Unsubscribe from Weekly News?' });
  await dlg.getByText('An unsubscribe email is sent from your address to olivia@acme.com.', { exact: false }).waitFor();
  await page.screenshot({ path: `${SP}/shots/unsubscribe.png` });
  await dlg.getByRole('button', { name: 'Unsubscribe' }).click();
  await page.getByText('Unsubscribe email sent to olivia@acme.com').waitFor();
  await page.getByRole('tablist', { name: 'Inbox tabs' }).getByRole('tab', { name: /Primary/ }).click(); // the unsubscribe request is ordinary mail
  await refreshUntil(page, inboxRow('Please unsubscribe me'));
  await page.getByRole('tablist', { name: 'Inbox tabs' }).getByRole('tab', { name: /Updates/ }).click();
});
await step('a list with only a web page: Unsubscribe is a link that opens it in a new tab', async () => {
  await refreshUntil(page, inboxRow('Deals inside'));
  await inboxRow('Deals inside').click();
  const link = page.locator('.reader-head').getByRole('link', { name: 'Unsubscribe' });
  if ((await link.getAttribute('href')) !== 'https://shop.example/leave?u=1' || (await link.getAttribute('target')) !== '_blank') throw new Error('link');
  if (!(await link.getAttribute('rel')).includes('noopener')) throw new Error('rel');
});
await step('ordinary mail has no Unsubscribe', async () => {
  await page.getByRole('tablist', { name: 'Inbox tabs' }).getByRole('tab', { name: /Primary/ }).click();
  await inboxRow('Please unsubscribe me').click();
  await page.locator('.reader-subject', { hasText: 'Please unsubscribe me' }).waitFor();
  if (await page.locator('.reader-head .unsub').count()) throw new Error('shown');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
