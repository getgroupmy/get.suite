// Mail at narrower windows (as narrowlayout.mjs does for the other apps): the Inbox, a message open with
// its toolbar, writing a message, and Mail's settings pages, at 1280, 1024, 820 and 390px. Runs with
// this machine's mail server (--mail).
import { chromium } from 'playwright';
import { layoutProblems } from './lib/layoutcheck.mjs';
import nodemailer from '../../server/node_modules/nodemailer/dist/cjs/nodemailer.js';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 500)); } };

await step('setup: a company with email, and a message in the Inbox', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).first().click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 60000 });
  const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
  await until(async () => { try { await smtp.sendMail({ from: '"Pat Partner from the Regional Procurement Office" <pat@acme.com>', to: 'olivia@acme.com', subject: 'Quarterly supplier review: the revised contract terms, the delivery schedule and next steps', text: 'Hello Olivia,\n\nThe revised terms are attached.\n\nPat' }); return true; } catch { return false; } });
  await until(async () => { await page.reload(); await page.waitForTimeout(1500); return page.locator('.mail-list').getByText(/Quarterly supplier review/).count(); }, 120000);
});

const found = [];
const check = async (name, width) => {
  const p = await layoutProblems(page);
  if (p.length) { found.push(`${name} at ${width}px: ${p.join('; ')}`); await page.screenshot({ path: `${SP}/shots/narrow-${name.replace(/\W+/g, '_')}-${width}.png` }); }
};
for (const width of [1280, 1024, 820, 390]) {
  await step(`Mail at ${width}px: headings readable, nothing over them, nothing off the edge`, async () => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`${B}/mail`);
    const row = page.locator('.mail-list').getByText(/Quarterly supplier review/).first();
    await row.waitFor({ timeout: 30000 });
    await check('Inbox', width);
    await row.click();
    await page.locator('.reader').getByText('The revised terms are attached.').waitFor();
    await page.waitForTimeout(300);
    await check('a message', width);
    if (width === 820 || width === 390) await page.screenshot({ path: `${SP}/shots/message-${width}.png` });
    if (width === 820) { // the message took the list's place: Back brings the list back
      if (await page.locator('.mail-list').isVisible()) throw new Error('list still beside the message at 820px');
      await page.getByRole('button', { name: 'Back to list' }).click();
      await page.locator('.mail-list').getByText(/Quarterly supplier review/).first().waitFor();
    }
    await page.goto(`${B}/mail`);
    await page.getByRole('button', { name: 'Compose' }).click();
    await page.getByLabel('Subject').waitFor();
    await page.waitForTimeout(300);
    await check('writing a message', width);
    await page.keyboard.press('Escape');
    for (const name of ['Vacation reply', 'Filters', 'Forwarding', 'Signature']) {
      await page.goto(`${B}/mail`);
      const link = page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true })).first();
      if (!(await link.count())) continue; // (on a phone these are in the folder strip)
      await link.click();
      await page.waitForTimeout(500);
      await check(`Mail ${name}`, width);
    }
    const here = found.filter((f) => f.includes(` at ${width}px`));
    if (here.length) throw new Error(here.join(' | '));
  });
}
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
