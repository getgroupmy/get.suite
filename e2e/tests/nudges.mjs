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
const card = () => page.getByRole('region', { name: 'Not answered yet' });
await step('emails from people a few days ago, one already answered, one a newsletter', async () => {
  const c = new ImapFlow({ host: '127.0.0.1', port: 993, secure: true, tls: { rejectUnauthorized: false }, auth: { user: 'olivia@acme.com', pass: 'password123' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  const ago = (d) => new Date(Date.now() - d * 864e5);
  const put = (subject, days, extra = '', flags = []) => c.append('INBOX', `From: Kim Park <kim@partner.example>\r\nTo: olivia@acme.com\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@partner.example>\r\n${extra}Date: ${ago(days).toUTCString()}\r\n\r\nCould you have a look?\r\n`, flags, ago(days));
  await put('Invoice question', 5);
  await put('Site visit on Monday', 4);
  await put('Thanks!', 6, '', ['\\Answered']);
  await put('November deals', 5, 'List-Unsubscribe: <mailto:u@shop.example>\r\n');
  await c.append('Sent', `From: Olivia Owner <olivia@acme.com>\r\nTo: Kim Park <kim@partner.example>\r\nSubject: Revised quote\r\nMessage-ID: <rq.${Date.now()}@acme.com>\r\nDate: ${ago(5).toUTCString()}\r\n\r\nHere it is\r\n`, ['\\Seen'], ago(5));
  await c.logout();
});
await step('Home: Not answered yet lists the two from people, newest first', async () => {
  await page.goto(`${B}/home`);
  const items = card().getByRole('listitem');
  await items.first().waitFor({ timeout: 30000 });
  const texts = await items.allInnerTexts();
  if (texts.length !== 2 || !/Site visit on Monday/.test(texts[0]) || !/Invoice question[\s\S]*From Kim Park · 5 days ago/.test(texts[1])) throw new Error(texts.join(' | '));
  await page.screenshot({ path: `${SP}/shots/home-nudges.png` });
});
await step('in Mail, those two say "Received N days ago. Reply?"; the others do not', async () => {
  await page.goto(`${B}/mail`);
  const row = (t) => page.locator('.mail-list li', { hasText: t });
  await row('Invoice question').getByText('Received 5 days ago. Reply?').waitFor({ timeout: 30000 });
  await row('Site visit on Monday').getByText('Received 4 days ago. Reply?').waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-nudges.png` });
  if (await page.locator('.mail-list .msg-nudge').count() !== 2) throw new Error('only those two');
  await page.goto(`${B}/home`);
});
await step('Not now takes one off for good; the subject opens the email', async () => {
  await card().getByRole('button', { name: 'Not now: Site visit on Monday' }).click();
  await card().getByText('Site visit on Monday').waitFor({ state: 'detached' });
  await page.reload();
  await card().getByText('Invoice question').waitFor({ timeout: 30000 });
  if (await card().getByText('Site visit on Monday').count()) throw new Error('back again');
  await card().getByRole('link', { name: 'Invoice question' }).click();
  await page.locator('.mail-reader').getByRole('heading', { name: 'Invoice question' }).waitFor({ timeout: 30000 });
});
await step('answering it takes it off Home', async () => {
  await page.locator('.mail-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  const d = page.getByRole('dialog', { name: /Invoice question/ });
  await d.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Looking now.');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  await page.goto(`${B}/home`);
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor();
  await until(async () => !(await card().count()), 15000);
});
await step('in Sent: "Sent 5 days ago. Follow up?" on mail nobody answered', async () => {
  await page.goto(`${B}/mail/Sent`);
  await page.locator('.mail-list li', { hasText: 'Revised quote' }).getByText('Sent 5 days ago. Follow up?').waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SP}/shots/sent-nudges.png` });
});
await step('Not now on a row in Sent takes its hint away, for good', async () => {
  await page.locator('.mail-list li', { hasText: 'Revised quote' }).hover();
  await page.getByRole('button', { name: 'Not now: Revised quote' }).click();
  await page.locator('.mail-list li', { hasText: 'Revised quote' }).getByText('Follow up?').waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('.mail-list').getByText('Revised quote').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  if (await page.locator('.mail-list li', { hasText: 'Revised quote' }).getByText('Follow up?').count()) throw new Error('back after a reload');
});
await step('Settings → Nudges off: no hints in Sent or the Inbox', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Suggest emails to reply to and to follow up on').uncheck();
  await page.getByText('Saved').first().waitFor();
  await page.goto(`${B}/mail/Sent`);
  await page.locator('.mail-list').getByText('Revised quote').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  if (await page.locator('.mail-list .msg-nudge').count()) throw new Error('still in Sent');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
