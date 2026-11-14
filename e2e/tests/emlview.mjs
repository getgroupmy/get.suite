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
await step('an email forwarded as an attachment opens in the viewer as an email', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Container arrived', text: 'The container is at dock 4.\nUnloading tomorrow.' })).status !== 200) throw new Error('send');
  await page.locator('.mail-list').getByText('Container arrived', { exact: true }).click({ timeout: 40000 });
  await page.getByRole('button', { name: 'Forward as attachment' }).click();
  await page.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 1 recipient/).waitFor({ timeout: 30000 });
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  k.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(k, 'kim@acme.com');
  await k.locator('.mail-list').getByText('Fwd: Container arrived', { exact: true }).click({ timeout: 40000 });
  await k.locator('a.att', { hasText: 'Container arrived.eml' }).click();
  const v = k.getByRole('dialog', { name: 'Container arrived.eml' });
  const email = v.getByRole('article', { name: 'Email: Container arrived' });
  await email.waitFor({ timeout: 15000 });
  await email.getByText('The container is at dock 4.').waitFor();
  await email.getByText(/olivia@acme\.com/).first().waitFor();
  await k.screenshot({ path: `${SP}/shots/eml-view.png` });
});
await step('an .eml file in Drive shows as an email too', async () => {
  const raw = ['From: Bob <bob@sender.example>', 'To: olivia@acme.com', 'Subject: Quote for the roof', 'Date: Tue, 10 Nov 2026 09:00:00 +0000', 'Content-Type: text/plain; charset=utf-8', '', 'The roof costs 4,000.'].join('\r\n');
  await page.evaluate(async (t) => fetch('/api/files/upload?name=Roof%20quote.eml', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t }), raw);
  await page.goto(`${B}/drive`);
  await page.getByText('Roof quote.eml').dblclick();
  await page.getByRole('article', { name: 'Email: Quote for the roof' }).getByText('The roof costs 4,000.').waitFor({ timeout: 15000 });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
