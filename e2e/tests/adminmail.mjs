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
await step('a colleague with a limit, and mail in both mailboxes', async () => {
  const k = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (k.status !== 201) throw new Error(JSON.stringify(k.body));
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
  for (const who of ['olivia', 'kim']) {
    const c = new ImapFlow({ host: '127.0.0.1', port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user: `${who}@acme.com`, pass: 'password123' }, logger: false });
    c.on('error', () => {});
    await c.connect();
    await c.append('INBOX', `From: x@example.com\r\nTo: ${who}@acme.com\r\nSubject: Report\r\n\r\n${'y'.repeat((who === 'kim' ? 950 : 300) * 1024)}\r\n`, []);
    await c.logout();
  }
  await api(page, 'PATCH', `/users/${k.body.id}`, { mail_quota_mb: 1 });
});
await step('Admin → Storage → Mailboxes: sizes and limits, the fullest first, with a warning bar', async () => {
  await page.goto(`${B}/admin?tab=storage`);
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Mailboxes' }) });
  const table = card.getByRole('table', { name: 'Mailboxes by person' });
  await table.waitFor({ timeout: 30000 });
  const rows = await table.locator('tbody tr').allInnerTexts();
  if (!/Kim Park/.test(rows[0]) || !/1\.0 MB · 9\d%/.test(rows[0])) throw new Error(rows.join(' | '));
  if (!/Olivia Owner[\s\S]*None/.test(rows.find((r) => /Olivia/.test(r)))) throw new Error('olivia: no limit');
  if (await table.locator('tbody tr').first().locator('.usage-bar.warn').count() !== 1) throw new Error('no warning bar');
  await page.screenshot({ path: `${SP}/shots/admin-mailboxes.png` });
});
await step('Check again asks the mail server afresh', async () => {
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Mailboxes' }) });
  await card.getByRole('button', { name: 'Check again' }).click();
  await card.getByRole('button', { name: 'Check again' }).waitFor();
  await card.getByText(/in all · checked/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
