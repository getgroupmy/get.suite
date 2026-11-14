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
const { ImapFlow } = await import(`${ROOT}/server/node_modules/imapflow/dist/esm/imap-flow.js`);
const putOld = async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user: 'olivia@acme.com', pass: 'password123' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  const old = new Date(Date.now() - 40 * 864e5);
  const msg = (subject, extra = '') => `From: Shop News <news@shop.example>\r\nTo: olivia@acme.com\r\nSubject: ${subject}\r\n${extra}Date: ${old.toUTCString()}\r\n\r\nDeals\r\n`;
  await c.append('INBOX', msg('Autumn deals', 'List-Unsubscribe: <mailto:u@shop.example>\r\n'), [], old);
  await c.append('INBOX', msg('Your receipt, keep it', 'List-Id: shop.example\r\n'), ['\\Flagged'], old);
  await c.logout();
};
await step('old updates in the inbox, one of them starred', async () => {
  await putOld();
  await page.goto(`${B}/mail`);
  await page.getByRole('tab', { name: /Updates/ }).click();
  await page.locator('.mail-list').getByText('Autumn deals', { exact: true }).waitFor({ timeout: 30000 });
});
await step('Settings → Tidy the inbox: after 30 days, then Tidy now', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Tidy the inbox' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Tidy the inbox' }) }));
  await card.getByLabel('Archive updates').selectOption({ label: 'After 30 days' });
  await page.getByText('Saved: old updates go to Archive each day').waitFor();
  await card.getByRole('button', { name: 'Tidy now' }).click();
  await page.getByText('1 message moved to Archive').waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SP}/shots/mail-tidy.png` });
});
await step('the old one is in Archive; the starred one stays in Updates', async () => {
  await page.goto(`${B}/mail`);
  await page.getByRole('tab', { name: /Updates/ }).click();
  await page.locator('.mail-list').getByText('Your receipt, keep it', { exact: true }).waitFor({ timeout: 30000 });
  if (await page.locator('.mail-list').getByText('Autumn deals', { exact: true }).count()) throw new Error('still in the inbox');
  await page.goto(`${B}/mail/Archive`);
  await page.locator('.mail-list').getByText('Autumn deals', { exact: true }).waitFor({ timeout: 30000 });
});
await step('Never turns it off (and hides Tidy now)', async () => {
  await page.goto(`${B}/settings`);
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Tidy the inbox' }) });
  await card.getByLabel('Archive updates').selectOption({ label: 'Never' });
  await page.getByText('Saved: updates stay in your inbox').waitFor();
  if (await card.getByRole('button', { name: 'Tidy now' }).count()) throw new Error('Tidy now still there');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
