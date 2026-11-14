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
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheet, kim;
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
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Fox']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  // The mail server picks up new accounts within a few seconds.
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 30000);
  await until(async () => (await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'warm-up', text: 'x' })).status === 200, 30000);
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Clients', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'First name', B1: 'Email', C1: 'Amount', A2: 'Kim', B2: 'kim@acme.com', C2: '120', D2: '', A3: 'Lee', B3: 'lee@acme.com', C3: '=C2/2', A4: 'Nobody', B4: 'not-an-address', C4: '1',
  } }] } })).body;
});
await step('write the message with placeholders and preview it for each person', async () => {
  await page.goto(`${B}/sheets/${sheet.id}`);
  await page.locator('.grid td[data-k="A1"]').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Mail merge…' }).click();
  const d = page.getByRole('dialog', { name: 'Mail merge' });
  if (await d.getByLabel('Send to the addresses in').inputValue() !== 'Email') throw new Error('email column not guessed');
  await d.getByLabel('Subject').fill('Your total, ');
  await d.getByRole('group', { name: 'Insert a column' }).getByRole('button', { name: 'First name' }).click();
  await d.getByLabel('Message').fill('Hello {{First name}},\nyou owe {{Amount}}.\nFrom {{Team}}');
  await d.getByText('No column called “Team”').waitFor();
  await d.getByLabel('Message').fill('Hello {{First name}},\nyou owe {{Amount}}.');
  const pv = d.getByRole('region', { name: 'Preview' });
  await pv.getByText('Your total, Kim').waitFor();
  await pv.getByText(/you owe 120\./).first().waitFor();
  await pv.getByRole('button', { name: 'Next person' }).click();
  await pv.getByText(/you owe 60\./).first().waitFor(); // formulas give what they show
  await d.getByText('1 row without a valid address will be skipped.').waitFor();
});
await step('send: each person gets their own email; the report lists what was skipped', async () => {
  const d = page.getByRole('dialog', { name: 'Mail merge' });
  await d.getByRole('button', { name: 'Send to 2 people…' }).click();
  await d.getByRole('button', { name: 'Yes, send 2 emails' }).click();
  await d.getByText(/2\s*emails sent; 1 not sent/).waitFor();
  await d.getByText('not-an-address: Not an email address').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  let msg;
  await until(async () => { const r = await api(kim, 'GET', '/mail/messages?folder=INBOX'); msg = r.body?.messages?.find((m) => m.subject === 'Your total, Kim'); return !!msg; }, 30000);
  const full = (await api(kim, 'GET', `/mail/messages/${msg.uid}?folder=INBOX`)).body;
  if (!/Hello Kim,\s+you owe 120\./.test(full.text) || full.to.length !== 1) throw new Error(JSON.stringify([full.text, full.to]));
}, page);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
