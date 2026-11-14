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
let kim, rob, group;
const inbox = async (p) => (await api(p, 'GET', '/mail/messages?folder=INBOX')).body?.messages || [];
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
await step('two colleagues, one in a group', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['rob', 'Rob Lee']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }
  const users = (await api(page, 'GET', '/users')).body;
  group = (await api(page, 'POST', '/groups', { name: 'Night shift' })).body;
  await api(page, 'PUT', `/groups/${group.id}/members`, { user_ids: [users.find((u) => u.username === 'kim@acme.com').id] });
  await page.waitForTimeout(6000); // the mail server picks up new mailboxes every few seconds
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  rob = await mk('rob'); await signIn(rob, 'rob@acme.com');
});
await step('an announcement for the group, also by email: its members get the email, others don\'t', async () => {
  await page.goto(`${B}/admin?tab=announcements`);
  await page.getByLabel('Announcement', { exact: true }).fill('Night shift: the new rota starts Monday');
  await page.getByLabel('Link (optional)').fill('/calendar');
  await page.getByLabel('Who sees it').selectOption({ label: 'Night shift (1)' });
  await page.getByLabel(/Also email it to them/).check();
  await page.getByRole('button', { name: 'Post' }).click();
  await page.getByText('Announcement posted: everyone in Night shift sees it now, and by email').waitFor();
  await page.getByRole('list', { name: 'Current announcements' }).getByText(/✉ emailed to 1/).waitFor();
  const m = await until(async () => (await inbox(kim)).find((x) => x.subject === 'Announcement: Night shift: the new rota starts Monday'), 30000);
  if (!/Olivia Owner/.test(JSON.stringify(m.from))) throw new Error(`from ${JSON.stringify(m.from)}`);
  await kim.goto(`${B}/mail`);
  await kim.getByText('Announcement: Night shift: the new rota starts Monday').first().click();
  await kim.locator('.mail-reader').getByText(/\/calendar/).waitFor();
  await kim.locator('.mail-reader').getByText(/to the Night shift group/).waitFor();
  await kim.screenshot({ path: `${SP}/shots/announce-email.png` });
  await page.waitForTimeout(1500);
  if ((await inbox(rob)).some((x) => /rota/.test(x.subject))) throw new Error('Rob is not in the group');
}, kim);
await step('scheduled with email: it goes when the announcement starts', async () => {
  const d = new Date(Date.now() + 60e3); d.setSeconds(0, 0);
  if (d.getTime() - Date.now() < 15e3) d.setMinutes(d.getMinutes() + 1);
  await page.getByLabel('Announcement', { exact: true }).fill('Maintenance tonight from 22:00');
  await page.getByLabel('Starts').fill(localInput(d));
  await page.getByLabel(/Also email it to them \(from you, when it starts\)/).check();
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByText(/Announcement scheduled: everyone in the company sees it from .*, and gets it by email then/).waitFor();
  await page.getByRole('list', { name: 'Scheduled announcements' }).getByText(/✉ will be emailed/).waitFor();
  await page.waitForTimeout(1500);
  if ((await inbox(rob)).some((x) => /Maintenance/.test(x.subject))) throw new Error('emailed before it starts');
  await until(async () => (await inbox(rob)).some((x) => x.subject === 'Announcement: Maintenance tonight from 22:00'), d.getTime() - Date.now() + 100e3);
  await until(async () => (await inbox(kim)).some((x) => x.subject === 'Announcement: Maintenance tonight from 22:00'), 20e3);
  await page.reload();
  await page.getByRole('list', { name: 'Current announcements' }).getByText(/Maintenance tonight.*✉ emailed to 3/).waitFor({ timeout: 20e3 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
