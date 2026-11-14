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
const row = (subject) => page.locator('.msg-list li', { hasText: subject });
const send = (subject) => page.evaluate(async (s) => fetch('/api/mail/send', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'olivia@acme.com', subject: s, text: 'Deal with this later' }) }).then((r) => r.status), subject);
const { DatabaseSync } = await import('node:sqlite');
await step('snooze an open message until tomorrow: it leaves the Inbox', async () => {
  for (const s of ['Quarterly numbers', 'Parking permit']) if (![200, 201].includes(await send(s))) throw new Error('send failed');
  await refreshUntil(page, row('Parking permit'));
  await row('Quarterly numbers').locator('.msg-row').click();
  await page.locator('.reader-subject', { hasText: 'Quarterly numbers' }).waitFor();
  await page.getByRole('button', { name: 'Snooze' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow · tomorrow at 8:00/ }).click();
  await page.locator('.toast', { hasText: 'Snoozed until tomorrow at 8:00' }).waitFor();
  await row('Quarterly numbers').waitFor({ state: 'detached' });
});
await step('it waits in Snoozed with when it comes back', async () => {
  await page.getByText('Snoozed', { exact: true }).first().click();
  await row('Quarterly numbers').locator('.snoozed-until').waitFor();
  const title = await row('Quarterly numbers').locator('.snoozed-until').getAttribute('title');
  if (!/Comes back tomorrow at 8:00/.test(title)) throw new Error(title);
  await page.screenshot({ path: `${SP}/shots/snoozed.png` });
});
await step('several at once, with a picked time; Unsnooze brings one back now', async () => {
  await page.getByText('Inbox', { exact: true }).first().click();
  await row('Parking permit').getByRole('checkbox').check();
  await page.locator('.mail-bulk').getByRole('button', { name: 'Snooze' }).click();
  await page.getByRole('menuitem', { name: 'Pick date and time…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Snooze until' });
  const d = new Date(Date.now() + 30 * 864e5);
  await dlg.getByLabel('Date').fill(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await dlg.getByLabel('Time').fill('09:30');
  await dlg.getByText(/comes back to your Inbox/).waitFor();
  await dlg.getByLabel('Date').fill('2099-01-02');
  await dlg.getByText('Choose a time within a year.').waitFor();
  await dlg.getByLabel('Date').fill(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await dlg.getByRole('button', { name: 'Snooze' }).click();
  await page.locator('.toast', { hasText: /Snoozed until .* at 9:30/ }).waitFor();
  await row('Parking permit').waitFor({ state: 'detached' });
  await page.getByText('Snoozed', { exact: true }).first().click();
  await row('Parking permit').locator('.msg-row').click();
  await page.getByRole('button', { name: 'Unsnooze' }).click();
  await page.locator('.toast', { hasText: 'Back in the Inbox' }).waitFor();
  await page.getByText('Inbox', { exact: true }).first().click();
  await row('Parking permit').waitFor();
});
await step('when the time comes it is back in the Inbox, unread, by itself', async () => {
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  db.prepare('UPDATE snoozed_mail SET until = ?').run(Date.now() - 1000);
  db.close();
  await row('Quarterly numbers').waitFor({ timeout: 40000 });
  if (!/unread/.test(await row('Quarterly numbers').getAttribute('class'))) throw new Error('should be unread');
  if (!/Quarterly numbers/.test(await page.locator('.msg-list li').first().innerText())) throw new Error('should be on top');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
