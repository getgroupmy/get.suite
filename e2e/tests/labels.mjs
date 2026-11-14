import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const row = (subject) => page.locator('.msg-list li', { hasText: subject });
const send = (subject) => page.evaluate(async (s) => fetch('/api/mail/send', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'olivia@acme.com', subject: s, text: 'Label test' }) }).then((r) => r.status), subject);
await step('make a label', async () => {
  for (const s of ['Invoice from Globex', 'Lunch on Friday', 'Contract draft']) if (![200, 201].includes(await send(s))) throw new Error('send');
  await refreshUntil(page, row('Contract draft'));
  await page.getByRole('button', { name: 'New label' }).click();
  const dlg = page.getByRole('dialog', { name: 'New label' });
  await dlg.getByLabel('Name').fill('Clients');
  await dlg.getByRole('radio', { name: '#0b8043' }).click();
  await dlg.getByRole('button', { name: 'Create' }).click();
  await page.locator('.subnav .folder-row', { hasText: 'Clients' }).waitFor();
});
await step('label an open message; the chip shows in the list and on the message', async () => {
  await row('Invoice from Globex').locator('.msg-row').click();
  await page.locator('.reader-subject', { hasText: 'Invoice from Globex' }).waitFor();
  await page.getByRole('button', { name: 'Labels', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clients' }).click();
  await page.locator('.reader-labels .label-chip', { hasText: 'Clients' }).waitFor();
  await row('Invoice from Globex').locator('.label-chip', { hasText: 'Clients' }).waitFor();
});
await step('label several at once from the selection', async () => {
  await row('Contract draft').getByRole('checkbox').check();
  await row('Lunch on Friday').getByRole('checkbox').check();
  await page.locator('.mail-bulk').getByRole('button', { name: 'Label' }).click();
  await page.getByRole('menuitem', { name: 'Clients' }).click();
  await page.locator('.toast', { hasText: 'Labelled Clients' }).waitFor();
  await row('Lunch on Friday').locator('.label-chip').waitFor();
  await page.screenshot({ path: `${SP}/shots/labels.png` });
});
await step('take one off with ×; the label view shows only labelled mail', async () => {
  await row('Lunch on Friday').locator('.msg-row').click();
  await page.locator('.reader-subject', { hasText: 'Lunch on Friday' }).waitFor();
  await page.getByRole('button', { name: 'Take off Clients' }).click();
  await row('Lunch on Friday').locator('.label-chip').waitFor({ state: 'detached' });
  await page.locator('.subnav .folder-row', { hasText: 'Clients' }).locator('.subnav-item').click();
  await page.getByText('Labelled').first().waitFor();
  await until(async () => (await page.locator('.msg-list li').count()) === 2);
  if (await row('Lunch on Friday').count()) throw new Error('not labelled');
  await row('Contract draft').locator('.msg-row').click();
  await page.locator('.reader-subject', { hasText: 'Contract draft' }).waitFor();
  if ((await page.locator('.msg-list li').count()) !== 2) throw new Error('opening a message keeps the label view');
});
await step('rename and recolour, then delete it from everything', async () => {
  await page.getByRole('button', { name: 'Options for label Clients' }).click();
  await page.getByRole('menuitem', { name: 'Edit label' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit label' });
  await dlg.getByLabel('Name').fill('Customers');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await row('Contract draft').locator('.label-chip', { hasText: 'Customers' }).waitFor();
  await page.getByRole('button', { name: 'Options for label Customers' }).click();
  await page.getByRole('menuitem', { name: 'Delete label' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete label' }).click();
  await page.locator('.subnav .folder-row', { hasText: 'Customers' }).waitFor({ state: 'detached' });
  await until(async () => (await page.locator('.msg-list li').count()) === 3);
  if (await page.locator('.msg-list .label-chip').count()) throw new Error('chips left');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
