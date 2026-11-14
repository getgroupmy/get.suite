import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
page.on('response', async (r) => { if (r.url().includes('/api/mail/drafts') || r.url().includes('/api/mail/send')) console.log('  RESP', r.request().method(), r.url().split('/api')[1], r.status(), (await r.text().catch(() => '')).slice(0, 80)); });
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
const drafts = (p) => p.getByRole('button', { name: /^Drafts/ });

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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});

await step('autosave-and-close-keeps-draft', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Shipping schedule');
  await page.getByLabel('Message', { exact: true }).fill('Hi Gina,\n\nHere is a first draft of the schedule.');
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/compose-autosave.png` });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.toast', { hasText: 'Draft saved' }).waitFor();
  await drafts(page).click();
  const row = page.locator('.msg-list li', { hasText: 'Shipping schedule' });
  await row.waitFor();
  await page.screenshot({ path: `${SP}/shots/drafts-folder.png` });
});

await step('resume-draft-and-send', async () => {
  await page.locator('.msg-list li', { hasText: 'Shipping schedule' }).locator('.msg-row').click();
  const body = page.getByLabel('Message', { exact: true });
  await body.waitFor();
  if (!(await body.innerText()).includes('first draft')) throw new Error('draft text not restored');
  if ((await page.getByLabel('To', { exact: true }).inputValue()) !== 'gina@globex.com') throw new Error('To not restored');
  await body.press('End');
  await body.pressSequentially(' Final version.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  await page.getByText('Drafts is empty').waitFor({ timeout: 10000 });
});

await step('discard-deletes-draft', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('Subject').fill('Never mind');
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Discard draft' }).click();
  try { await page.locator('.toast', { hasText: 'Draft discarded' }).waitFor({ timeout: 8000 }); }
  catch { throw new Error('no discard toast; toasts=' + await page.locator('.toasts').innerText() + ' compose open=' + await page.locator('.compose').count()); }
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('Drafts is empty').waitFor();
});

const gina = await mk('gina');
await step('vacation-on-and-reply-arrives', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  await gina.locator('.msg-list li', { hasText: 'Shipping schedule' }).waitFor({ timeout: 30000 });
  await gina.getByRole('button', { name: /Vacation reply/ }).click();
  await gina.getByLabel(/Send an automatic reply/).check();
  await gina.getByLabel('Subject').fill('Away at the port');
  await gina.getByLabel('Message', { exact: true }).fill('I am at the port inspection until Friday.\nUrgent: call the office.');
  await gina.screenshot({ path: `${SP}/shots/vacation-dialog.png` });
  await gina.getByRole('button', { name: 'Save' }).click();
  await gina.getByText('Your vacation reply is on.').waitFor();
  await gina.screenshot({ path: `${SP}/shots/vacation-banner.png` });
  await gina.waitForTimeout(3500); // mail server loads the new script

  await page.getByRole('button', { name: /^Inbox/ }).click();
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Question about the container');
  await page.getByLabel('Message', { exact: true }).fill('Where is it?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  const reply = page.locator('.msg-list li', { hasText: 'Away at the port' });
  await refreshUntil(page, reply);
  await reply.locator('.msg-row').click();
  await page.getByText('I am at the port inspection until Friday.').waitFor();
}, gina);

await step('vacation-scheduled-then-off', async () => {
  await gina.getByRole('button', { name: 'Edit' }).click();
  await gina.getByLabel('First day (optional)').fill('2099-03-01');
  await gina.getByRole('button', { name: 'Save' }).click();
  await gina.getByText(/Your vacation reply starts on/).waitFor();
  await gina.locator('.vacation-link .pill', { hasText: 'Scheduled' }).waitFor();
  await gina.getByRole('button', { name: 'Turn off' }).click();
  await gina.locator('.toast', { hasText: 'Vacation reply turned off' }).waitFor();
  if (await gina.locator('.mail-vacation').count()) throw new Error('banner still shown');
}, gina);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
