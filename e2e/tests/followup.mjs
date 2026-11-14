import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
await step('send with "no reply in a week": the sent message shows the reminder, which can be cancelled', async () => {
  await compose('Contract signed?', 'Did you sign it?');
  await page.getByLabel('Remind me if no reply').selectOption('7');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => (await api(page, 'GET', '/mail/followups')).body.length === 1, 30000);
  const f = (await api(page, 'GET', '/mail/followups')).body[0];
  if (f.subject !== 'Contract signed?' || f.due_at < Date.now() + 6.9 * 864e5) throw new Error(JSON.stringify(f));
  await page.locator('.folder-row').getByText('Sent', { exact: true }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Contract signed?', { exact: true }));
  await page.locator('.mail-list').getByText('Contract signed?', { exact: true }).click();
  const banner = page.getByRole('region', { name: 'Follow-up' });
  await banner.getByText(/You'll be reminded .* if nobody has replied/).waitFor();
  await banner.getByRole('button', { name: 'Cancel reminder' }).click();
  await page.getByText('Follow-up reminder cancelled').waitFor();
  await until(async () => (await api(page, 'GET', '/mail/followups')).body.length === 0);
});
await step('messages sent without one show nothing', async () => {
  await page.locator('.folder-row').getByText('Inbox', { exact: true }).click();
  await compose('Just FYI', 'No answer needed');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Just FYI', { exact: true }));
  await page.locator('.mail-list').getByText('Just FYI', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Just FYI' }).waitFor(); await page.waitForTimeout(800);
  if (await page.getByRole('region', { name: 'Follow-up' }).count()) throw new Error('banner shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
