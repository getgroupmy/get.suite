import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
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
  console.log('DBG status', await page.evaluate(async () => (await fetch('/api/auth/status')).text()));
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Compose' }).or(page.getByRole('link', { name: 'Drive', exact: true })).first().waitFor();
  await page.goto(`${B}/mail`);
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
const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await step('mail on a phone: folders readable in the strip; several new emails, one note', async () => {
  await page.getByRole('button', { name: 'Compose' }).waitFor();
  await page.waitForTimeout(4000); // the page's live new-mail watch is set up
  for (let i = 1; i <= 3; i++) await smtp.sendMail({ from: 'Pat Partner <pat@acme.com>', to: 'olivia@acme.com', subject: `Quarterly numbers ${i}`, text: 'Here are the figures for this quarter.' });
  await page.locator('.toast', { hasText: /new emails, from Pat Partner|New mail from Pat Partner/ }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const notes = await page.locator('.toast', { hasText: /mail|emails/ }).count();
  if (notes > 2) throw new Error(`${notes} notes`);
  const inbox = page.locator('.subnav .folder-row', { hasText: 'Inbox' }).first();
  const b = await inbox.boundingBox();
  if (!b || b.width < 60) throw new Error(`Inbox in the strip: ${JSON.stringify(b)}`);
  if (!(await page.locator('.subnav').getByText('Inbox', { exact: true }).first().isVisible())) throw new Error('the name Inbox is hidden');
  const strip = await page.locator('.subnav').first().boundingBox();
  if (strip.width < 360) throw new Error(`the strip is only ${strip.width}px wide`);
  if (await over() > 2) throw new Error('wider than the screen');
});
await step('mail on a phone: writing a message takes the whole screen; it sends', async () => {
  await refreshUntil(page, page.getByText('Quarterly numbers 3').first());
  await page.getByRole('button', { name: 'Compose' }).click();
  const dlg = page.getByRole('dialog', { name: 'New message' });
  const b = await dlg.boundingBox();
  if (Math.round(b.width) < 388 || b.x > 1 || Math.round(b.height) < 840) throw new Error(`compose ${JSON.stringify(b)}`);
  await dlg.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await dlg.getByLabel('Subject').fill('From my phone');
  await dlg.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Sent on the go.');
  await dlg.getByRole('button', { name: 'Send', exact: true }).click();
  await refreshUntil(page, page.getByText('From my phone').first());
  await page.screenshot({ path: `${SP}/shots/mm-after.png` });
});
await step('look', async () => {
  await page.goto(`${B}/mail`);
  await refreshUntil(page, page.getByText('Quarterly numbers 3').first());
  console.log('DBG list overflow', await over());
  await page.screenshot({ path: `${SP}/shots/mm-list.png` });
  await page.getByText('Quarterly numbers 3').first().click();
  await page.waitForTimeout(1500);
  console.log('DBG open overflow', await over());
  await page.screenshot({ path: `${SP}/shots/mm-open.png` });
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.waitForTimeout(800);
  console.log('DBG compose overflow', await over());
  await page.screenshot({ path: `${SP}/shots/mm-compose.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
