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
await step('two large emails in the inbox', async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user: 'olivia@acme.com', pass: 'password123' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  const big = (subject, kb) => `From: Kim Park <kim@acme.com>\r\nTo: olivia@acme.com\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(76).concat('\r\n').repeat(Math.ceil((kb * 1024) / 78))}`;
  await c.append('INBOX', big('Holiday photos', 1500), []);
  await c.append('INBOX', big('Scanned contract', 700), []);
  await c.logout();
});
await step('Mail → Storage: the total, folders by size, and the largest messages', async () => {
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Storage' }).click();
  const d = page.getByRole('dialog', { name: 'Mailbox storage' });
  await d.getByText(/used$/).first().waitFor({ timeout: 30000 });
  await d.getByRole('table', { name: 'Folders by size' }).getByRole('row', { name: /^Inbox/ }).waitFor();
  const list = d.getByRole('list', { name: 'Largest messages' });
  const items = await list.getByRole('listitem').allInnerTexts();
  if (!/Holiday photos/.test(items[0]) || !/Scanned contract/.test(items[1])) throw new Error(items.join(' | '));
  if (!/1\.\d MB/.test(items[0])) throw new Error(`size: ${items[0]}`);
  await page.screenshot({ path: `${SP}/shots/mail-storage.png` });
});
await step('Delete moves one to Trash (and says Trash still counts); Open opens the other', async () => {
  const d = page.getByRole('dialog', { name: 'Mailbox storage' });
  await d.getByRole('button', { name: 'Delete Holiday photos' }).click();
  await page.getByText('Moved to Trash: empty Trash to free the space').waitFor();
  const list = d.getByRole('list', { name: 'Largest messages' });
  await list.getByRole('listitem').filter({ hasText: 'Holiday photos' }).filter({ hasText: 'Trash' }).waitFor();
  await list.getByRole('listitem').filter({ hasText: 'Scanned contract' }).getByRole('button', { name: 'Open' }).click();
  await d.waitFor({ state: 'detached' });
  await page.locator('.mail-reader').getByRole('heading', { name: 'Scanned contract' }).waitFor({ timeout: 30000 });
});
await step('with a mailbox limit, how full it is', async () => {
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  await api(page, 'PATCH', `/users/${me.id}`, { mail_quota_mb: 2 });
  await page.getByRole('button', { name: 'Storage' }).click();
  const d = page.getByRole('dialog', { name: 'Mailbox storage' });
  await d.getByText(/of 2\.0 MB used \(\d+%\)/).waitFor({ timeout: 30000 });
  await d.getByRole('meter', { name: 'Mailbox used' }).waitFor();
  await d.getByText('Your mailbox is nearly full', { exact: false }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
