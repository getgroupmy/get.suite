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
  await reader().getByRole('button', { name: 'Archive' }).click();
  await reader().getByText('About Alpha note').waitFor();
});
await step('newer: deleting the open message opens the one above it', async () => {
  await api(page, 'PUT', '/users/me/mail-advance', { advance: 'newer' });
  await page.reload();
  await reader().getByText('About Alpha note').waitFor();
  await reader().getByRole('button', { name: 'Delete' }).click();
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
  await reader().getByRole('button', { name: 'Archive' }).click();
  await page.getByText('No message selected').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
