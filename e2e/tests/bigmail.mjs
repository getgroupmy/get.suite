// A mailbox with a lot in it (with this machine's mail server, --mail): 5,000 emails in the Inbox, put
// there by the mail server's own import. Listing a page, the next page, searching, opening one and the
// Inbox on screen each stay quick.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const timed = (url) => page.evaluate(async (u) => { const t = performance.now(); const r = await fetch('/api' + u, { headers: { 'x-requested-with': 'nas-workspace' } }); const body = await r.json().catch(() => null); return { ms: performance.now() - t, status: r.status, body }; }, url);
const N = 5000;
const DIR = '/var/tmp/nw-bigmail'; // readable by the mail server (it imports from here)

await step('setup: a company with email, and 5,000 emails in the Inbox', async () => {
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
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const lines = [];
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 600e3);
    lines.push(`From sender${i % 300}@example.com ${d.toUTCString().replace(',', '')}`, `From: Sender ${i % 300} <sender${i % 300}@example.com>`, 'To: olivia@acme.com',
      `Subject: Order ${String(i).padStart(4, '0')} confirmation`, `Date: ${d.toUTCString()}`, `Message-ID: <order${i}@example.com>`, '', `Thank you for order ${i}. It ships soon.`, '');
  }
  fs.writeFileSync(`${DIR}/inbox`, lines.join('\n'));
  fs.chmodSync(DIR, 0o777); fs.chmodSync(`${DIR}/inbox`, 0o666);
  const t = Date.now();
  execFileSync('sudo', ['doveadm', 'import', '-u', 'olivia@acme.com', `mbox:${DIR}:INBOX=${DIR}/inbox`, '', 'all']);
  console.log(`imported ${N} in ${Date.now() - t}ms`);
  fs.rmSync(DIR, { recursive: true, force: true });
  const first = await timed('/mail/messages?folder=INBOX');
  if (first.body?.total !== N) throw new Error(`Inbox has ${first.body?.total}`);
});

await step('listing, the next page, searching and opening one each answer within two seconds', async () => {
  const list = await timed('/mail/messages?folder=INBOX');
  const page2 = await timed('/mail/messages?folder=INBOX&page=2');
  const search = await timed(`/mail/messages?folder=INBOX&q=${encodeURIComponent('Order 4321')}`);
  const uid = list.body.messages[0].uid;
  const open = await timed(`/mail/messages/${uid}?folder=INBOX`);
  const folders = await timed('/mail/folders');
  const t = { list: list.ms, page2: page2.ms, search: search.ms, open: open.ms, folders: folders.ms };
  console.log(`timings: ${Object.entries(t).map(([k, v]) => `${k} ${Math.round(v)}ms`).join(', ')}`);
  if (!search.body?.messages?.some((m) => m.subject === 'Order 4321 confirmation')) throw new Error(`search found ${JSON.stringify(search.body?.messages?.map((m) => m.subject))}`);
  if (list.body.messages[0].subject !== `Order ${N - 1} confirmation`) throw new Error(`newest first: ${list.body.messages[0].subject}`);
  const slow = Object.entries(t).filter(([, v]) => v > 2000);
  if (slow.length) throw new Error(slow.map(([k, v]) => `${k} ${Math.round(v)}ms`).join(', '));
});

await step('the Inbox shows the newest at once, and a message opens', async () => {
  const t = Date.now();
  await page.goto(`${B}/mail`);
  await page.locator('.mail-list').getByText(`Order ${N - 1} confirmation`).waitFor({ timeout: 15000 });
  const shown = Date.now() - t;
  await page.locator('.mail-list').getByText(`Order ${N - 1} confirmation`).click();
  await page.locator('.reader').getByText(`Thank you for order ${N - 1}.`).waitFor({ timeout: 15000 });
  console.log(`shown: Inbox ${shown}ms, message ${Date.now() - t - shown}ms`);
  await page.screenshot({ path: `${SP}/shots/bigmail.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
