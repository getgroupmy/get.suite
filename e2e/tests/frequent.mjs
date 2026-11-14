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
await step('Contacts → Frequent: who you email most, colleague marked; Email starts a message; Add to contacts', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const sendTo = async (to, n) => { for (let i = 0; i < n; i++) for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to, subject: `Hi ${i}`, text: 'x' })).status === 200) break; await page.waitForTimeout(1500); } };
  await sendTo('kim@acme.com', 3);
  await sendTo('Pat Partner <pat@partner.example>', 1);
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Frequent' }).click();
  const table = page.getByRole('table', { name: 'Frequently contacted' });
  const rows = table.locator('tbody tr');
  await rows.first().getByText('Kim Park').waitFor({ timeout: 10000 });
  await rows.first().getByText('colleague').waitFor();
  await rows.first().getByText('3 times').waitFor();
  await rows.nth(1).getByText('Pat Partner').waitFor();
  await page.screenshot({ path: `${SP}/shots/contacts-frequent.png` });
  await rows.nth(1).getByRole('button', { name: 'Add to contacts' }).click();
  await page.getByText('Pat Partner added to your contacts').waitFor();
  await until(async () => (await rows.nth(1).getByRole('button', { name: 'Add to contacts' }).count()) === 0);
  await rows.first().getByRole('button', { name: 'Email' }).click();
  await page.getByRole('dialog', { name: 'New message' }).waitFor();
  await until(async () => /kim@acme\.com/.test(await page.getByLabel('To', { exact: true }).inputValue()));
});
await step('Home: People you email most, most first; Email starts a message; the heading opens Contacts → Frequent', async () => {
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'People you email most' });
  await card.locator('li').first().getByText('Kim Park').waitFor({ timeout: 10000 });
  await card.getByText('3 times').waitFor();
  await page.screenshot({ path: `${SP}/shots/home-people.png` });
  await card.getByRole('button', { name: 'Email Kim Park' }).click();
  await page.getByRole('dialog', { name: 'New message' }).waitFor();
  await until(async () => /kim@acme\.com/.test(await page.getByLabel('To', { exact: true }).inputValue()));
  await page.keyboard.press('Escape');
  await page.goto(`${B}/home`);
  await page.getByRole('region', { name: 'People you email most' }).getByRole('link', { name: /People you email most/ }).click();
  await page.getByRole('table', { name: 'Frequently contacted' }).waitFor();
});
await step('Forget one (× on the row), then Clear all empties the list', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Frequent' }).click();
  const table = page.getByRole('table', { name: 'Frequently contacted' });
  await table.getByText('Pat Partner').waitFor();
  await table.getByRole('button', { name: 'Forget Pat Partner' }).click();
  await page.getByText('Pat Partner forgotten').waitFor();
  await table.getByText('Pat Partner').waitFor({ state: 'detached' });
  await table.getByText('Kim Park').waitFor();
  const inc = await api(page, 'GET', '/mail/includes?to=kim@acme.com');
  if (inc.status !== 200) throw new Error(`includes ${inc.status}`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.getByText('Nobody yet').waitFor();
  const left = (await api(page, 'GET', '/contacts/frequent')).body;
  if (left.length) throw new Error('not cleared');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
