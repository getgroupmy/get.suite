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
await step('save one attachment, then all of them, to Drive', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Invoices', text: 'Two invoices attached.',
    attachments: [{ filename: 'invoice-1.txt', content: 'first invoice' }, { filename: 'a/b.txt', content: 'second invoice' }] });
  await refreshUntil(page, inboxRow('Invoices'));
  await inboxRow('Invoices').click();
  await page.getByRole('button', { name: 'Save invoice-1.txt to Drive' }).click();
  await page.getByText('Saved invoice-1.txt to Drive').waitFor();
  await page.getByRole('button', { name: 'Save all to Drive' }).click();
  await page.getByText('Saved 2 files to Drive').waitFor();
  await page.getByRole('button', { name: 'Show', exact: true }).last().click();
  await page.waitForURL(/\/drive\/folder\//);
  await page.getByText('Email attachments').first().waitFor();
  for (const n of ['invoice-1.txt', 'a_b.txt']) await page.getByText(n, { exact: true }).first().waitFor();
  const list = (await api(page, 'GET', '/files?view=search&q=invoice')).body;
  const f = list.find((x) => x.name === 'invoice-1.txt');
  const raw = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/raw`)).text(), f.id);
  if (raw !== 'first invoice') throw new Error('content ' + raw);
  if (list.filter((x) => x.name.startsWith('invoice-1')).length !== 2) throw new Error('expected a second copy ' + list.map((x) => x.name));
});
await step('Attach from Drive in compose still works', async () => {
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('button', { name: 'Attach from Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach from Drive' });
  await pick.getByLabel('Search your files').fill('a_b');
  await pick.getByRole('button', { name: /a_b\.txt/ }).click();
  await pick.waitFor({ state: 'detached' });
  await page.getByText('a_b.txt').first().waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
