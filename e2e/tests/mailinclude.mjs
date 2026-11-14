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
const run = Date.now().toString(36);
await step('include: writing to Kim suggests Lee, who is usually on it; clicking adds Lee; × waves one away', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Chen'], ['max', 'Max Moss']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(`user ${r.status}`);
  }
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 10; k++) {
      if ((await api(page, 'POST', '/mail/send', { to: 'Kim Park <kim@acme.com>, Lee Chen <lee@acme.com>', cc: 'Max Moss <max@acme.com>', subject: `Plan ${run} ${i}`, text: 'x' })).status === 200) break;
      await page.waitForTimeout(1500);
    }
  }
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await page.getByLabel('Subject').click();
  const box = page.getByRole('group', { name: 'People you usually include' });
  await box.getByRole('button', { name: 'Lee Chen', exact: true }).waitFor({ timeout: 10000 });
  await box.getByRole('button', { name: 'Max Moss', exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-include.png` });
  await box.getByRole('button', { name: 'Lee Chen', exact: true }).click();
  await until(async () => (await page.getByLabel('To', { exact: true }).inputValue()) === 'kim@acme.com, Lee Chen <lee@acme.com>');
  await box.getByRole('button', { name: 'Don’t suggest Max Moss' }).click();
  await box.waitFor({ state: 'detached' });
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('See you there.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 2 recipients/).waitFor({ timeout: 20000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
