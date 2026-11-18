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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); } };
let kim;
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
await step('send a message as high importance; the draft keeps it', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.getByText('Inbox is empty').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await page.getByLabel('Subject').fill('Server room flooding');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Please come now.');
  await page.getByLabel('High importance').check();
  // saved as a draft with it, and opened again with it ticked
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=Drafts')).body?.messages || []).some((m) => m.subject === 'Server room flooding'), 20000);
  const draft = (await api(page, 'GET', '/mail/messages?folder=Drafts')).body.messages.find((m) => m.subject === 'Server room flooding');
  if ((await api(page, 'GET', `/mail/drafts/${draft.uid}`)).body.importance !== 'high') throw new Error('draft lost it');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor({ timeout: 20000 });
});
await step('the recipient sees “!” in the list and a note in the message; is:important finds it', async () => {
  const row = kim.locator('.mail-list li, .mail-list .msg', { hasText: 'Server room flooding' }).first();
  await refreshUntil(kim, kim.locator('.mail-list').getByText(/Server room flooding/));
  await row.getByLabel('High importance').waitFor();
  await kim.locator('.mail-list').getByText(/Server room flooding/).click();
  await kim.getByRole('note').getByText('The sender marked this message as high importance.').waitFor();
  await kim.screenshot({ path: `${SP}/shots/mail-importance.png` });
  // Mail from another mail app (Thunderbird's X-Priority), and an ordinary one: only the first is important.
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'kim@acme.com', subject: 'Board pack due', text: 'Today.', headers: { 'X-Priority': '1 (Highest)' } });
  await smtp.sendMail({ from: 'Team <team@acme.com>', to: 'kim@acme.com', subject: 'Weekly news', text: 'Hello.' });
  // (they may land in the Updates tab: looked for in the whole Inbox)
  await until(async () => { const all = (await api(kim, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []; return ['Weekly news', 'Board pack due'].every((x) => all.some((m) => m.subject === x)); }, 60000);
  const found = await until(async () => { const r = await api(kim, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent('is:important')}`); return r.status === 200 && r.body.messages; });
  const subjects = found.map((m) => m.subject).sort().join(' | ');
  if (subjects !== 'Board pack due | Server room flooding') throw new Error(subjects);
  const news = (await api(kim, 'GET', '/mail/messages?folder=INBOX')).body.messages.find((m) => m.subject === 'Weekly news');
  if (news.importance) throw new Error('an ordinary one marked');
}, kim);
await step('a filter “Importance is high → Star it” stars important mail as it arrives, and only that', async () => {
  await kim.getByRole('button', { name: 'Filters' }).click();
  const dlg = kim.getByRole('dialog', { name: 'Filters' });
  await dlg.getByRole('button', { name: /New filter/ }).click();
  const ed = kim.getByRole('dialog', { name: 'New filter' });
  await ed.getByLabel('Name').fill('Urgent');
  await ed.getByLabel('Condition 1 field').selectOption('importance');
  if (await ed.getByLabel('Condition 1 value').count()) throw new Error('no value to type for importance');
  await ed.getByLabel('Condition 1 comparison').selectOption('high');
  await ed.getByRole('checkbox', { name: 'Star it' }).check();
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await dlg.getByText(/it’s marked high importance/).waitFor();
  await kim.screenshot({ path: `${SP}/shots/filter-importance.png` });
  await kim.keyboard.press('Escape');
  await kim.waitForTimeout(7000); // (the mail server takes up saved filters within a few seconds)
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'kim@acme.com', subject: 'Outage now', text: 'Call me.', headers: { Importance: 'High' } });
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'kim@acme.com', subject: 'Lunch menu', text: 'Soup.' });
  const msgs = await until(async () => { const all = (await api(kim, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []; return ['Outage now', 'Lunch menu'].every((x) => all.some((m) => m.subject === x)) && all; }, 60000);
  const by = (x) => msgs.find((m) => m.subject === x);
  if (!by('Outage now').flagged || by('Lunch menu').flagged) throw new Error(JSON.stringify([by('Outage now'), by('Lunch menu')].map((m) => [m.subject, m.flagged])));
}, kim);
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
