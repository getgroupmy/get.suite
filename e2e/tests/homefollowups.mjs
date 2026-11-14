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
const { DatabaseSync } = await import('node:sqlite');
const card = () => page.getByRole('region', { name: 'Waiting for a reply' });
await step('send two emails asking to be reminded if nobody replies', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
  for (const subject of ['Quote for the fit-out', 'Lunch on Friday?']) {
    let r;
    for (let k = 0; k < 8; k++) { r = await api(page, 'POST', '/mail/send', { to: 'kim@acme.com', subject, text: 'Let me know', followUp: 3 }); if (r.status === 200) break; await page.waitForTimeout(1500); }
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
});
await step('Home: Waiting for a reply lists them with when the reminder is', async () => {
  await page.goto(`${B}/home`);
  await card().getByText('Quote for the fit-out').waitFor({ timeout: 30000 });
  await card().getByText(/^Reminder .* · to kim@acme\.com$/).first().waitFor();
});
await step('the reminder comes due with no reply: "no reply yet", live; Done takes it off', async () => {
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  db.prepare("UPDATE mail_followups SET due_at = ? WHERE subject = 'Quote for the fit-out'").run(Date.now() - 1000);
  db.close();
  const item = card().getByRole('listitem').filter({ hasText: 'Quote for the fit-out' });
  await item.getByText('No reply yet').waitFor({ timeout: 40000 }); // the server checks every 20 seconds
  await page.screenshot({ path: `${SP}/shots/home-followups.png` });
  await item.getByRole('button', { name: 'Done with Quote for the fit-out' }).click();
  await item.waitFor({ state: 'detached' });
});
await step('Cancel stops waiting for the other; the card goes when empty', async () => {
  await card().getByRole('button', { name: 'Stop waiting for Lunch on Friday?' }).click();
  await card().waitFor({ state: 'detached' });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
