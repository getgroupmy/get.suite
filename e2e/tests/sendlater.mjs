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
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};

await step('undo send: the message waits a few seconds and Undo brings it back', async () => {
  await compose('Oops wrong person', 'Please ignore');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: 'Sending…' }).waitFor();
  if (await page.getByRole('dialog', { name: 'New message' }).isVisible()) throw new Error('the window should step aside');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('dialog', { name: 'New message' }).waitFor();
  await page.waitForTimeout(6500);
  await page.getByRole('dialog', { name: 'New message' }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor({ timeout: 15000 });
  await refreshUntil(page, inboxRow('Oops wrong person'));
  if (await inboxRow('Oops wrong person').count() !== 1) throw new Error('sent more than once');
});

await step('schedule send for a chosen time; it waits in Scheduled; Send now sends it', async () => {
  await compose('Monthly report', 'Numbers for the month');
  await page.getByRole('button', { name: 'Schedule for later' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow morning/ }).waitFor();
  await page.getByRole('menuitem', { name: 'Pick date and time…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Schedule send' });
  const t = new Date(Date.now() + 2 * 864e5);
  await dlg.getByLabel('Date').fill(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  await dlg.getByLabel('Time').fill('09:30');
  await dlg.getByRole('button', { name: 'Schedule send' }).click();
  await page.getByText(/^Will be sent .* at 9:30/).waitFor();
  await page.getByRole('button', { name: /^Scheduled/ }).click();
  const list = page.getByRole('dialog', { name: 'Scheduled' });
  await list.getByText('Monthly report').waitFor();
  await list.getByText(/Sends .* at 9:30/).waitFor();
  await page.screenshot({ path: `${SP}/shots/scheduled.png` });
  await list.getByRole('button', { name: 'Send now' }).click();
  await page.getByText('Sent', { exact: true }).waitFor();
  await list.getByText('Nothing is waiting to be sent.').waitFor();
  await page.keyboard.press('Escape');
  await refreshUntil(page, inboxRow('Monthly report'));
  if (await page.getByRole('button', { name: /^Scheduled/ }).count()) throw new Error('Scheduled should go when empty');
});

await step("don't send: a scheduled message goes back to Drafts; Undo on the toast does the same", async () => {
  await compose('Second thoughts', 'Maybe not');
  await page.getByRole('button', { name: 'Schedule for later' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow afternoon/ }).click();
  await page.getByText(/^Will be sent tomorrow at 1:00/).waitFor();
  await page.getByRole('button', { name: /^Scheduled/ }).click();
  await page.getByRole('dialog', { name: 'Scheduled' }).getByRole('button', { name: 'Don’t send' }).click();
  await page.getByText('Not sent: it’s back in Drafts').waitFor();
  await page.keyboard.press('Escape');
  await compose('Undo this one', 'x');
  await page.getByRole('button', { name: 'Schedule for later' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow morning/ }).click();
  await page.locator('.toast', { hasText: /Will be sent tomorrow at 8:00/ }).getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Not sent: it’s back in Drafts').first().waitFor();
  await page.locator('.subnav').getByRole('button', { name: /^Drafts/ }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Second thoughts'));
  await refreshUntil(page, page.locator('.mail-list').getByText('Undo this one'));
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
