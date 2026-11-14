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
await step('Print opens a clean page of the message for the print dialog', async () => {
  for (let k = 0; k < 5; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Invoice <42>', text: 'Please pay by Friday.\nThanks' })).status === 200) break; await page.waitForTimeout(1000); }
  await page.locator('.mail-list').getByText('Invoice <42>', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Invoice <42>', { exact: true }).click();
  await page.locator('.mail-reader').getByText('Please pay by Friday.').waitFor();
  await page.evaluate(() => { window.__printed = 0; const orig = HTMLIFrameElement.prototype; void orig; });
  await page.locator('.mail-reader').getByRole('button', { name: 'Print' }).click();
  const frame = page.frameLocator('iframe.print-frame');
  await frame.locator('h1', { hasText: 'Invoice <42>' }).waitFor({ state: 'attached' });
  if (!(await frame.locator('.message').textContent()).includes('Please pay by Friday.')) throw new Error('body');
  const from = await frame.locator('table.head').textContent();
  if (!/From:\s*Olivia Owner <olivia@acme.com>/.test(from.replace(/\s+/g, ' ')) || !/To:/.test(from) || !/Date:/.test(from)) throw new Error(from);
  const sandbox = await page.locator('iframe.print-frame').getAttribute('sandbox');
  if (/allow-scripts/.test(sandbox)) throw new Error('scripts allowed');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
