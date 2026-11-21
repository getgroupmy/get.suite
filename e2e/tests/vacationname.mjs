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
  await page.getByLabel('Your full name').fill('Olivia "Liv"; Owner'); // (a name with a quote and a semicolon)
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); } };
const send = async (p, body) => { for (let k = 0; k < 20; k++) { const r = await api(p, 'POST', '/mail/send', body); if (r.status === 200) return r; await p.waitForTimeout(1500); } throw new Error('could not send'); };
const upload = (name, bytes) => page.evaluate(async ([n, len]) => (await (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x'.repeat(len) })).json()).id, [name, bytes]);
const inbox = async (folder = 'INBOX') => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(folder)}`)).body.messages || [];

// With the out-of-office reply on, the mail server's script for this person has a From line with their name in it: a
// name with ; or " made that line invalid, so the server refused the whole script and no filter ran (mail stayed in the
// Inbox). Delivered through the real mail server here.
await step('out of office on, a name with ; and " in it: a filter still files mail away', async () => {
  const v = await api(page, 'PUT', '/mail/vacation', { enabled: true, subject: 'Away', body: 'Back on Monday.', start_date: null, end_date: null });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  const r = await api(page, 'PUT', '/mail/rules', { rules: [{ name: 'Budgets', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'Budget' }], actions: { moveTo: 'Budget' } }] });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await page.waitForTimeout(2500); // (the server's files written)
  await send(page, { to: 'olivia@acme.com', subject: 'Budget for Q1', text: 'Numbers attached.' });
  await until(async () => (await inbox('Budget')).some((m) => m.subject === 'Budget for Q1'), 30000);
  if ((await inbox()).some((m) => m.subject === 'Budget for Q1')) throw new Error('also in the Inbox');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
