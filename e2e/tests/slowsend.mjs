// Sending an email on a slow connection (with this machine's mail server, --mail): pressing Send twice
// while the first is on its way sends it once.
import { chromium } from 'playwright';
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
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

await step('setup: a company with email', async () => {
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
});

await step('Send pressed twice on a slow connection sends one email', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill('Sent once please');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Only one of these.');
  await page.route(/\/api\/mail\/(send|messages\/send|schedule)/, async (route) => { if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2000)); await route.continue(); });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await send.click();
  await send.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(15000); // past any "undo send" wait, and delivered
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let n = 0;
  for (let k = 0; k < 20; k++) {
    const r = await api('GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent('Sent once please')}`);
    n = (r.body?.messages || []).filter((m) => m.subject === 'Sent once please').length;
    if (n) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000);
  const r = await api('GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent('Sent once please')}`);
  n = (r.body?.messages || []).filter((m) => m.subject === 'Sent once please').length;
  if (n !== 1) throw new Error(`${n} arrived`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
