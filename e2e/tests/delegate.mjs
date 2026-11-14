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
await step('Settings → Mail delegation: Olivia gives Kim her mail', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Mail delegation' });
  await card.getByLabel("Colleague's email address").fill('kim@acme.com');
  await card.getByRole('button', { name: 'Give access' }).click();
  await page.getByText('They can now read and answer your mail').waitFor();
  await card.getByRole('list', { name: 'People who have your mail' }).getByText('Kim Park').waitFor();
  await page.waitForTimeout(3000); // the mail server picks up Kim's new mailbox
  await send(page, { to: 'olivia@acme.com', subject: 'Board pack for Thursday', text: 'Please print 10 copies.' });
});
await step('Kim picks Olivia’s mail under Mailbox and reads it there (no team-mailbox extras)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); kim = await ctx.newPage();
  kim.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(kim, 'kim@acme.com');
  await kim.getByLabel('Mailbox').selectOption((await api(kim, 'GET', '/mail/status')).body.shared.find((x) => x.delegated).id);
  await kim.getByText(/Olivia Owner’s mail: what you send comes from olivia@acme\.com/).waitFor();
  await refreshUntil(kim, kim.locator('.mail-list').getByText('Board pack for Thursday', { exact: true }));
  await kim.locator('.mail-list').getByText('Board pack for Thursday', { exact: true }).click();
  await kim.locator('.mail-reader').getByText('Please print 10 copies.').waitFor();
  if (await kim.locator('.mail-reader').getByRole('region', { name: /Given to|Internal notes/ }).count()) throw new Error('team extras shown');
  if (await kim.getByRole('button', { name: 'Filters' }).count()) throw new Error('personal tools shown');
});
await step('Kim writes as Olivia; it comes from Olivia and says Kim sent it', async () => {
  await kim.getByRole('button', { name: 'Compose' }).click();
  await kim.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await kim.getByLabel('Subject').fill('Copies are ready');
  await kim.getByRole('textbox', { name: 'Message' }).click();
  await kim.keyboard.type('Ten copies on your desk.');
  await kim.getByRole('button', { name: 'Send', exact: true }).click();
  await kim.getByLabel('Mailbox').selectOption('');
  await refreshUntil(kim, kim.locator('.mail-list').getByText('Copies are ready', { exact: true }));
  await kim.locator('.mail-list').getByText('Copies are ready', { exact: true }).click();
  await kim.locator('.mail-reader').getByText('Olivia Owner', { exact: true }).first().waitFor();
  await kim.locator('.mail-reader .sent-by', { hasText: 'sent by Kim Park <kim@acme.com>' }).waitFor();
});
await step('Olivia takes it back: Kim no longer has the mailbox', async () => {
  await page.getByRole('region', { name: 'Mail delegation' }).getByRole('button', { name: 'Remove Kim Park' }).click();
  await page.getByText('Kim Park no longer has your mail').waitFor();
  await kim.reload();
  await kim.getByRole('button', { name: 'Compose' }).waitFor();
  if (await kim.getByLabel('Mailbox').count()) throw new Error('still offered');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
