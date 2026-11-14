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
const search = async (q) => { await page.getByLabel('Search mail').fill(q); await page.getByLabel('Search mail').press('Enter'); };
await step('search with from: and has:attachment', async () => {
  await smtp.sendMail({ from: 'Raj <raj@acme.com>', to: 'olivia@acme.com', subject: 'Invoice March', text: 'see attached', attachments: [{ filename: 'inv.txt', content: 'x' }] });
  await smtp.sendMail({ from: 'Raj <raj@acme.com>', to: 'olivia@acme.com', subject: 'Invoice question', text: 'no file' });
  await smtp.sendMail({ from: 'Kim <kim@acme.com>', to: 'olivia@acme.com', subject: 'Invoice from Kim', text: 'file', attachments: [{ filename: 'k.txt', content: 'y' }] });
  await refreshUntil(page, inboxRow('Invoice from Kim'));
  await refreshUntil(page, inboxRow('Invoice question'));
  await search('from:raj has:attachment');
  await inboxRow('Invoice March').waitFor();
  await page.waitForTimeout(500);
  if (await inboxRow('Invoice question').count() || await inboxRow('Invoice from Kim').count()) throw new Error('too many');
  await search('invoice -march -kim');
  await inboxRow('Invoice question').waitFor();
  await page.waitForTimeout(500);
  if (await inboxRow('Invoice March').count()) throw new Error('excluded word shown');
});
await step('a mistake in the search is explained', async () => {
  await search('before:yesterday');
  await page.getByText('Write dates as YYYY-MM-DD (before:yesterday)').waitFor();
});
await step('no errors in the browser', async () => { if (errors.filter((e) => !/400/.test(e)).length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
