import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { imapLogin } from './lib/probe.mjs';
const SP = process.argv[2];
const B = 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
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
  await page.waitForTimeout(4000); // mail server picks up the new account and policy settings
});

await step('imap-attack-gets-blocked', async () => {
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => imapLogin('olivia@acme.com', `guess${i}`, '127.0.0.6')));
  if (!r.every((x) => x.startsWith('NO'))) throw new Error(r.join('|'));
  const after = await imapLogin('olivia@acme.com', 'password123', '127.0.0.6');
  if (!/Too many failed sign-ins/.test(after)) throw new Error('not blocked: ' + after.slice(0, 80));
});

await step('security-tab', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Security' }).click();
  await page.locator('.card', { hasText: 'Blocked addresses' }).getByRole('cell', { name: '127.0.0.6', exact: true }).waitFor();
  await page.getByText(/10 failed sign-ins in 15 min \(imap\)/).waitFor();
  await page.getByText('Mail app (IMAP)').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/security.png`, fullPage: true });
});

await step('unblock', async () => {
  await page.getByRole('button', { name: 'Unblock' }).click();
  await page.getByText('Nothing is blocked right now.').waitFor();
  const ok = await imapLogin('olivia@acme.com', 'password123', '127.0.0.6');
  if (!ok.startsWith('OK')) throw new Error(ok.slice(0, 80));
});

await step('allowlist', async () => {
  await page.getByLabel('Allowlisted addresses').fill('127.0.0.6\n198.51.100.0/24');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Allowlist saved').waitFor();
  const r = await Promise.all(Array.from({ length: 12 }, (_, i) => imapLogin('olivia@acme.com', `again${i}`, '127.0.0.6')));
  const after = await imapLogin('olivia@acme.com', 'password123', '127.0.0.6');
  if (!after.startsWith('OK')) throw new Error('allowlisted address was blocked: ' + after.slice(0, 80));
  await page.getByLabel('Allowlisted addresses').fill('not an ip');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/is not an IP address or range/).waitFor();
});

// Someone guessing passwords on the Workspace sign-in page from the internet (via the reverse proxy).
const attackerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.50' } });
const ap = await attackerCtx.newPage();
await step('web-login-blocked', async () => {
  await ap.goto(B);
  for (let i = 0; i < 10; i++) {
    await ap.getByLabel('Email address').fill('olivia@acme.com');
    await ap.getByLabel('Password').fill(`wrong-${i}`);
    await ap.getByRole('button', { name: 'Sign in' }).click();
    await ap.getByRole('alert').getByText('Wrong email address or password').waitFor();
  }
  await ap.getByLabel('Password').fill('password123');
  await ap.getByRole('button', { name: 'Sign in' }).click();
  await ap.getByRole('alert').getByText('Too many failed sign-ins from your network. Try again later.').waitFor();
  await ap.screenshot({ path: `${SP}/shots/login-blocked.png` });
}, ap);

await step('web-ban-visible-to-admin', async () => {
  await page.reload();
  await page.getByRole('tab', { name: 'Security' }).click();
  await page.locator('.card', { hasText: 'Blocked addresses' }).getByRole('cell', { name: '203.0.113.50', exact: true }).waitFor();
  await page.getByText(/\(web\)/).waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
