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
await step('vacation reply with Also mark me Out of office: the calendar has it; turning the reply off takes it away', async () => {
  const day = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };
  await page.getByRole('button', { name: /Vacation reply/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Vacation reply' });
  await dlg.getByRole('checkbox', { name: "Send an automatic reply while I'm away" }).check();
  const cal = dlg.getByRole('checkbox', { name: 'Also mark me Out of office in my calendar for these days' });
  if (!(await cal.isDisabled())) throw new Error('enabled without a last day');
  await dlg.getByLabel('First day (optional)').fill(day(7));
  await dlg.getByLabel('Last day (optional)').fill(day(9));
  await cal.check();
  await dlg.getByLabel('Message').fill('Back soon.');
  await page.screenshot({ path: `${SP}/shots/vacation-ooo.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Vacation reply saved, and you’re Out of office in your calendar').waitFor();
  const from = Date.parse(`${day(6)}T00:00:00Z`), to = Date.parse(`${day(11)}T00:00:00Z`);
  const ooo = async () => (await api(page, 'GET', `/events?from=${from}&to=${to}`)).body.filter((e) => e.kind === 'ooo');
  const got = await ooo();
  if (got.length !== 1 || !got[0].all_day) throw new Error(JSON.stringify(got).slice(0, 200));
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).waitFor();
  // Off again: the event goes.
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: /Vacation reply/ }).first().click();
  await dlg.getByRole('checkbox', { name: "Send an automatic reply while I'm away" }).uncheck();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Vacation reply off').waitFor();
  await until(async () => (await ooo()).length === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
