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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); } };
const send = async (p, body) => { for (let k = 0; k < 20; k++) { const r = await api(p, 'POST', '/mail/send', body); if (r.status === 200) return r; await p.waitForTimeout(1500); } throw new Error('could not send'); };
let kim;
await step('an admin makes support@ a shared mailbox for Kim', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Email' }).or(page.getByRole('button', { name: 'Email', exact: true })).first().click();
  const card = page.getByRole('region', { name: 'Shared mailboxes' });
  await card.getByRole('button', { name: 'Add shared mailbox' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add shared mailbox' });
  await dlg.getByLabel('Address before @').fill('support');
  await dlg.getByLabel('Name (shown on the mail it sends)').fill('Acme Support');
  await dlg.getByLabel(/Kim Park/).check();
  await dlg.getByLabel('Automatic reply to whoever writes in (once a day per sender)').check();
  await dlg.getByLabel('Reply text').fill('Thanks, we will answer within a day.');
  await dlg.getByLabel(/^Signature for mail written as it/).fill('{name}\nAcme Support team');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await card.getByText('support@acme.com').waitFor();
  await card.getByText('Kim Park').waitFor();
  const box = (await api(page, 'GET', '/mail-admin/shared')).body[0];
  if (box.auto_reply !== 'Thanks, we will answer within a day.' || box.auto_subject !== 'We got your message') throw new Error(JSON.stringify(box));
});
await step('mail to support@ shows for Kim under Mailbox → Acme Support, not in her own inbox', async () => {
  await page.waitForTimeout(3000); // the mail server picks up the new mailbox
  await send(page, { to: 'support@acme.com', subject: 'Question about invoice 77', text: 'Hello support' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); kim = await ctx.newPage();
  kim.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(kim, 'kim@acme.com');
  await kim.getByText('Acme Support: 1 unread').waitFor({ timeout: 30000 });
  await kim.getByLabel('Mailbox').selectOption({ label: 'Acme Support (support@acme.com) · 1 unread' });
  await kim.getByText('Shared mailbox support@acme.com').waitFor();
  await refreshUntil(kim, kim.locator('.mail-list').getByText('Question about invoice 77', { exact: true }));
  if (await kim.getByRole('button', { name: 'Filters' }).count()) throw new Error('personal tools shown');
});
await step('Kim replies; it goes out from support@ and Olivia receives it from there', async () => {
  await kim.locator('.mail-list').getByText('Question about invoice 77', { exact: true }).click();
  const reader = kim.locator('.mail-reader');
  if (await reader.getByRole('button', { name: 'Labels' }).count()) throw new Error('labels in shared');
  await reader.getByRole('button', { name: 'Reply', exact: true }).click();
  const ed = kim.getByRole('textbox', { name: 'Message' });
  await ed.click();
  await kim.keyboard.type('We have sent a new copy.');
  await ed.getByText('Acme Support team').waitFor();
  await ed.getByText('Kim Park').waitFor();
  if (await kim.getByRole('button', { name: 'Schedule for later' }).count()) throw new Error('scheduling offered');
  await kim.getByRole('button', { name: 'Send', exact: true }).click();
  const got = await until(async () => (await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages?.find((m) => m.subject === 'Re: Question about invoice 77' && m.from.address === 'support@acme.com'), 40000);
  const body = (await api(page, 'GET', `/mail/messages/${got.uid}?folder=INBOX`)).body;
  if (!/Kim Park\s+Acme Support team/.test(body.text)) throw new Error(body.text);
}, kim);
await step('Kim gives it to Olivia (also on the mailbox); Olivia is told, sees it under Given to me, and marks it done', async () => {
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  const box = (await api(page, 'GET', '/mail-admin/shared')).body[0];
  await api(page, 'PATCH', `/mail-admin/shared/${box.id}`, { members: [...box.members.map((x) => x.id), me] });
  await kim.reload();
  await kim.locator('.mail-list').getByText(/Question about invoice 77/).first().click();
  const bar = kim.getByRole('group', { name: 'Who answers this' });
  await bar.getByLabel('Given to').selectOption({ label: 'Olivia Owner' });
  await kim.getByText('Given to Olivia Owner').waitFor();
  const notes = kim.getByRole('region', { name: 'Internal notes' });
  await notes.getByLabel('Add an internal note').fill('Customer is on the gold plan');
  await notes.getByRole('button', { name: 'Add note' }).click();
  await notes.getByText('Customer is on the gold plan').waitFor();
  await kim.locator('.mail-list').getByText('💬 1').first().waitFor();
  await kim.locator('.mail-list').getByText('→ Olivia Owner').first().waitFor();
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: /Notifications/ }).first().click();
  await page.getByText('Kim Park gave you an email in support@acme.com').waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Mailbox').selectOption({ label: /Acme Support/ }).catch(async () => { const v = await page.getByLabel('Mailbox').locator('option', { hasText: 'Acme Support' }).getAttribute('value'); await page.getByLabel('Mailbox').selectOption(v); });
  await page.getByRole('tab', { name: 'Given to me' }).click();
  const row = page.locator('.mail-list').getByText(/Question about invoice 77/).first();
  await row.waitFor();
  await row.click();
  await page.getByRole('region', { name: 'Internal notes' }).getByText('Customer is on the gold plan').waitFor();
  await page.getByRole('group', { name: 'Who answers this' }).getByRole('button', { name: 'Mark done' }).click();
  await page.getByText('Marked done').waitFor();
  await until(async () => !(await page.locator('.mail-list').getByText(/Question about invoice 77/).count()));
  await page.getByRole('tab', { name: 'All' }).click();
  await page.locator('.mail-list').getByText('✓ Done').first().waitFor();
}, page);
await step('back to Your mail: the support message is not there', async () => {
  await kim.getByLabel('Mailbox').selectOption({ label: 'Your mail' });
  await kim.waitForTimeout(1500);
  if (await kim.getByText('Shared mailbox support@acme.com').count()) throw new Error('still shared');
  if (await kim.locator('.mail-list').getByText('Question about invoice 77', { exact: true }).count()) throw new Error('in own inbox');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
