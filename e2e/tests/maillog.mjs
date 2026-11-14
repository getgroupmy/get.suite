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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
const req = (await import('module')).createRequire(`${ROOT}/server/package.json`);
const nodemailer = req('nodemailer');
const stamp = Date.now();
await step('Admin → Email → Email log: delivered and refused mail, with what the server said', async () => {
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 90000);
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.example.org' });
  await t.sendMail({ from: `quotes-${stamp}@acme.com`, to: 'postmaster@acme.com', subject: 'Quote', text: 'x' });
  await t.sendMail({ from: `quotes-${stamp}@acme.com`, to: `nobody-${stamp}@acme.com`, subject: 'x', text: 'x' }).catch(() => {});
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Email' }).click();
  const card = page.getByRole('heading', { name: 'Email log' }).locator('xpath=ancestor::div[contains(@class,"card")]');
  await card.getByLabel('Address or Message-ID').fill(`quotes-${stamp}`);
  const table = card.getByRole('table', { name: 'Email log' });
  await until(async () => {
    await card.getByRole('button', { name: 'Search' }).click();
    await page.waitForTimeout(800);
    return (await table.count()) && (await table.getByText('Refused').count()) && (await table.getByText('Delivered').count());
  }, 30000);
  await table.getByText(/User unknown/).waitFor();
  await table.getByText('(sent to postmaster@acme.com)').waitFor();
  await card.getByLabel('What happened').selectOption('refused');
  await card.getByRole('button', { name: 'Search' }).click();
  await until(async () => (await table.getByText('Delivered').count()) === 0);
  await page.screenshot({ path: `${SP}/shots/maillog.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
