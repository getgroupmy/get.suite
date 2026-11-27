import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

// Mail reopens an email left open when the page was last closed: close it before starting another.
const closeOpenCompose = async () => {
  await page.waitForTimeout(500);
  for (const open of await page.getByRole('dialog').all()) { const close = open.getByRole('button', { name: 'Close' }); if (await close.count()) { await close.first().click(); await open.waitFor({ state: 'detached' }).catch(() => {}); } }
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
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
await step('older: archiving the open message opens the one below it', async () => {
  for (const s of ['Alpha note', 'Bravo note', 'Charlie note']) { await send(s); await page.waitForTimeout(1200); }
  await page.goto(`${B}/mail`);
  await row('Charlie note').waitFor({ timeout: 40000 });
  await row('Alpha note').waitFor({ timeout: 40000 });
  await api(page, 'PUT', '/users/me/mail-advance', { advance: 'older' });
  await page.goto(`${B}/mail`);
  await row('Bravo note').click();
  await reader().getByText('About Bravo note').waitFor();
  await reader().getByRole('button', { name: 'Archive', exact: true }).click();
  await reader().getByText('About Alpha note').waitFor();
});
await step('newer: deleting the open message opens the one above it', async () => {
  await api(page, 'PUT', '/users/me/mail-advance', { advance: 'newer' });
  await page.reload();
  await reader().getByText('About Alpha note').waitFor();
  await reader().getByRole('button', { name: 'Delete', exact: true }).click();
  await reader().getByText('About Charlie note').waitFor();
});
await step('back to the list (the default), chosen in Settings', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Go back to the list').check();
  await page.getByText('Saved').first().waitFor();
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  if (me.mail_advance !== 'list') throw new Error(me.mail_advance);
  await page.goto(`${B}/mail`);
  await row('Charlie note').click();
  await reader().getByText('About Charlie note').waitFor();
  await reader().getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByText('No message selected').waitFor();
});
await step('default reply: everyone first, and R replies to everyone', async () => {
  await api(page, 'POST', '/users', { local: 'bob', domain: 'acme.com', name: 'Bob Builder', password: 'password123' });
  for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', cc: 'bob@acme.com', subject: 'Group note', text: 'About Group note' })).status === 200) break; await page.waitForTimeout(1500); }
  await page.goto(`${B}/settings`);
  await page.getByLabel('Reply to everyone').check();
  await page.getByText('Saved').first().waitFor();
  if ((await api(page, 'GET', '/auth/me')).body.user.mail_reply !== 'all') throw new Error('not saved');
  await page.goto(`${B}/mail`);
  await row('Group note').click({ timeout: 40000 });
  await reader().getByText('About Group note').waitFor();
  const first = (await reader().locator('.reader-reply button').first().textContent()).trim();
  if (first !== 'Reply all') throw new Error('first is ' + first);
  await page.keyboard.press('r');
  await until(async () => /bob@acme\.com/.test(await page.getByLabel('Cc', { exact: true }).inputValue().catch(() => '')));
});
await step('default reply: the sender again, Reply first', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Reply to the sender').check();
  await page.getByText('Saved').first().waitFor();
  await page.goto(`${B}/mail`);
  await closeOpenCompose();
  await row('Group note').click();
  await reader().getByText('About Group note').waitFor();
  const first = (await reader().locator('.reader-reply button').first().textContent()).trim();
  if (first !== 'Reply') throw new Error('first is ' + first);
});
const unread = async (subj) => page.locator('.mail-list li', { has: page.getByText(subj, { exact: true }) }).evaluate((li) => li.classList.contains('unread'));
await step('mark as read after 5 seconds: unread while glancing, read once it stays open', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('After 5 seconds open').check();
  await page.getByText('Saved').first().waitFor();
  await send('Delta note');
  await page.goto(`${B}/mail`);
  await row('Delta note').click({ timeout: 40000 });
  await reader().getByText('About Delta note').waitFor();
  await page.waitForTimeout(1500);
  if (!(await unread('Delta note'))) throw new Error('read straight away');
  await until(async () => !(await unread('Delta note')), 9000);
});
await step('never: an opened email stays unread until marked by hand', async () => {
  await api(page, 'PUT', '/users/me/mail-read-after', { after: -1 });
  await send('Echo note');
  await page.goto(`${B}/mail`);
  await row('Echo note').click({ timeout: 40000 });
  await reader().getByText('About Echo note').waitFor();
  await page.waitForTimeout(6500);
  await page.reload();
  await row('Echo note').waitFor();
  if (!(await unread('Echo note'))) throw new Error('was marked read');
  await api(page, 'PUT', '/users/me/mail-read-after', { after: 0 });
});
await step('default text style: chosen in Settings, shown while writing, and in the email sent', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Default text style' });
  await card.getByLabel('Font').selectOption('Georgia');
  await card.getByLabel('Size').selectOption('Large');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved').first().waitFor();
  if ((await api(page, 'GET', '/auth/me')).body.user.mail_style?.font !== 'Georgia') throw new Error('not saved');
  await page.goto(`${B}/mail`);
  await closeOpenCompose();
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill('Styled note');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('In my own style');
  const css = await box.evaluate((el) => { const c = getComputedStyle(el); return `${c.fontFamily}|${c.fontSize}`; });
  if (!/Georgia/.test(css) || !css.endsWith('18px')) throw new Error(css);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const msg = await until(async () => (((await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages) || []).find((m) => m.subject === 'Styled note'), 60000);
  const full = (await api(page, 'GET', `/mail/messages/${msg.uid}?folder=INBOX&peek=1`)).body;
  if (!/font-family: Georgia, serif; font-size: 18px/.test(full.html || '')) throw new Error((full.html || '').slice(0, 200));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
