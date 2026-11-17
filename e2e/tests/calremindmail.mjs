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
await step('tick Email me my event reminders in Calendar settings', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  const d = page.getByRole('dialog', { name: 'Calendar settings' });
  await d.getByLabel(/Email me my event reminders too/).check();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Calendar settings saved').waitFor();
  if ((await api(page, 'GET', '/auth/me')).body.user.cal_prefs.emailReminders !== true) throw new Error('not saved');
});
await step('a reminder as it comes due arrives in the inbox', async () => {
  const start = Date.now() + 75e3; // a reminder 1 minute before: due in about 15 seconds
  const r = await api(page, 'POST', '/events', { title: 'Budget review', start, end: start + 30 * 6e4, location: 'Room 4', reminders: [1] });
  if (r.status >= 300) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/mail`);
  await until(async () => {
    const l = (await api(page, 'GET', '/mail/messages?folder=INBOX')).body;
    return (l?.messages || []).some((m) => /Reminder: Budget review · In 1 minute/.test(m.subject));
  }, 150000);
  await page.reload();
  await page.locator('.mail-list').getByText('Reminder: Budget review · In 1 minute').click();
  await page.locator('.mail-reader').getByText('Where: Room 4').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
