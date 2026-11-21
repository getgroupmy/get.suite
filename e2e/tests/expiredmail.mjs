// Writing an email when the session has ended (with this machine's mail server, --mail): pressing Send asks
// you to sign in, nothing is sent, and the email you wrote is waiting afterwards (open, or in Drafts).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

await step('setup: a company with email', async () => {
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
});

await step('an email written as the session ends is waiting after signing in', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill('Quarterly figures');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('The numbers are in. Revenue is up eleven percent.');
  await page.waitForTimeout(300);
  await ctx.clearCookies(); // the session ends with the email still open
  await page.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 3000 }).catch(() => {});
  await page.getByLabel(/Password/).first().waitFor({ timeout: 15000 });
  await page.getByLabel(/Email/).first().fill('olivia@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SP}/shots/expiredmail.png` });
  console.log(`after signing in: ${page.url().replace(B, '')}`);
  const open = await page.getByLabel('Subject').count() ? await page.getByLabel('Subject').inputValue() : null;
  const bodyText = open !== null ? await page.getByRole('textbox', { name: 'Message' }).innerText() : '';
  let drafts = [];
  for (let k = 0; k < 10; k++) {
    drafts = ((await api('GET', '/mail/messages?folder=Drafts')).body?.messages || []).filter((m) => m.subject === 'Quarterly figures');
    if (drafts.length || open !== null) break;
    await page.waitForTimeout(1000);
  }
  console.log(`compose open: ${JSON.stringify(open)} body ${JSON.stringify(bodyText)}; drafts: ${drafts.length}`);
  const inbox = ((await api('GET', '/mail/messages?folder=INBOX')).body?.messages || []).filter((m) => m.subject === 'Quarterly figures');
  if (inbox.length) throw new Error('it was sent after all');
  if (open === 'Quarterly figures') {
    console.log('PATH reopened');
    if (!bodyText.includes('Revenue is up eleven percent')) throw new Error(`the open email has “${bodyText}”`);
    // and it can be sent now
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    let n = 0;
    for (let k = 0; k < 30 && !n; k++) { await page.waitForTimeout(1000); n = ((await api('GET', '/mail/messages?folder=INBOX')).body?.messages || []).filter((m) => m.subject === 'Quarterly figures').length; }
    if (n !== 1) throw new Error(`${n} arrived after sending it`);
    await page.reload();
    await page.waitForTimeout(2000);
    if (await page.getByLabel('Subject').count()) throw new Error('sent, yet it opens again after reloading');
  } else {
    if (!drafts.length) throw new Error('the email is gone: not open, not in Drafts');
    const d = (await api('GET', `/mail/messages/${drafts[0].uid}?folder=Drafts`)).body;
    if (!JSON.stringify(d).includes('Revenue is up eleven percent')) throw new Error('the draft lacks what was typed last');
  }
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
