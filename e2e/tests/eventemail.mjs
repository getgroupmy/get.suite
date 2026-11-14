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
let kim, ev;
await step('an event with a colleague as a guest', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(14, 0, 0, 0);
  ev = (await api(page, 'POST', '/events', { title: 'Budget review', location: 'Room 2', start: start.getTime(), end: start.getTime() + 36e5, guests: ['kim@acme.com'] })).body;
  if (!ev?.id) throw new Error(JSON.stringify(ev));
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
});
await step('the organizer: ✉ Email guests opens a message to the guests about the event; it arrives', async () => {
  await page.goto(`${B}/calendar?event=${ev.id}`);
  await page.getByRole('button', { name: '✉ Email guests' }).click();
  const d = page.getByRole('dialog', { name: 'Budget review' }).filter({ has: page.getByLabel('Subject') });
  await d.waitFor({ timeout: 30000 });
  if (await d.getByLabel('Subject').inputValue() !== 'Budget review') throw new Error('subject');
  await until(async () => (await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('kim@acme.com'));
  if ((await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('olivia@acme.com')) throw new Error('not to yourself');
  const msg = d.getByRole('textbox', { name: 'Message' });
  await msg.getByText('Where:').waitFor();
  await msg.getByText('Room 2').waitFor();
  const href = await msg.getByRole('link', { name: 'Budget review in Calendar' }).getAttribute('href');
  if (href !== `${B}/calendar?event=${ev.id}`) throw new Error(`link ${href}`);
  await page.screenshot({ path: `${SP}/shots/event-email.png` });
  await msg.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Please bring the Q3 figures.');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.locator('.mail-list').getByText('Budget review', { exact: true }).first().waitFor({ timeout: 40000 });
});
await step('a guest: Email guests in the invitation writes to the organizer', async () => {
  await kim.goto(`${B}/calendar?event=${ev.id}`);
  await kim.getByRole('button', { name: '✉ Email guests' }).click();
  const d = kim.getByRole('dialog', { name: 'Budget review' }).filter({ has: kim.getByLabel('Subject') });
  await d.waitFor({ timeout: 30000 });
  await until(async () => (await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('olivia@acme.com'));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
