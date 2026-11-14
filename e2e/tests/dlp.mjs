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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
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
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (to, subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill(to);
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
};
await step('the admin adds two rules, trying one first', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Data protection' }).click();
  await page.getByText('No rules yet').waitFor();
  await page.getByRole('button', { name: 'Add rule' }).click();
  let d = page.getByRole('dialog', { name: 'New rule' });
  await d.getByLabel('Name').fill('Card numbers');
  await d.getByLabel('Look for').selectOption('card');
  await d.getByLabel('Then').selectOption('block');
  await d.getByLabel('Text to try the rule on').fill('order 1234 5678 9012 3456, card 4111 1111 1111 1111');
  await d.getByRole('button', { name: 'Try' }).click();
  await d.getByRole('status').getByText('Found: …1111').waitFor();
  await d.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('table', { name: 'Data protection rules' }).getByRole('cell', { name: 'Card numbers', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add rule' }).click();
  d = page.getByRole('dialog', { name: 'New rule' });
  await d.getByLabel('Name').fill('Falcon');
  await d.getByLabel('Look for').selectOption('words');
  await d.getByLabel('Words or phrases (separated by commas)').fill('Project Falcon');
  await d.getByLabel('When sent to').selectOption('all');
  await d.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('table', { name: 'Data protection rules' }).getByRole('cell', { name: 'Falcon', exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/dlp-admin.png` });
});
await step('a card number to someone outside is stopped, and the message stays open', async () => {
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
  await compose('client@example.org', 'Payment details', 'Use 4111 1111 1111 1111 please');
  await page.getByText(/can’t be sent: it contains a credit card number/).first().waitFor({ timeout: 15000 });
  await page.getByRole('dialog', { name: 'New message' }).getByLabel('Subject').waitFor(); // still open to change
  await page.keyboard.press('Escape');
});
await step('protected words ask first; Send anyway sends it', async () => {
  await page.goto(`${B}/mail`);
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
  await compose('olivia@acme.com', 'Falcon plan', 'Project Falcon starts Monday');
  const w = page.getByRole('dialog', { name: 'Check before sending' });
  await w.getByText('words your company protects (Falcon: Project Falcon)').waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SP}/shots/dlp-warn.png` });
  await w.getByRole('button', { name: 'Send anyway' }).click();
  await page.getByText(/Sent to 1 recipient/).waitFor({ timeout: 20000 });
  await refreshUntil(page, inboxRow('Falcon plan'));
});
await step('both are in the activity log', async () => {
  const log = JSON.stringify((await api(page, 'GET', '/audit?limit=50')).body);
  if (!log.includes('dlp.blocked') || !log.includes('dlp.sent_anyway')) throw new Error(log.slice(0, 300));
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
