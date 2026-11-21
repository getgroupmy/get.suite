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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
let ch, kim;
await step('an anonymous poll that closes in an hour: Kim votes; Olivia sees a count, not who', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'team' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await page.goto(`${B}/chat/${ch}`);
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const d = page.getByRole('dialog', { name: 'Create a poll' });
  await d.getByLabel('Question').fill('Is the workload OK?');
  await d.getByLabel('Option 1').fill('Yes');
  await d.getByLabel('Option 2').fill('Too much');
  await d.getByLabel(/Anonymous: show how many/).check();
  await d.getByLabel('Closes').selectOption({ label: 'In an hour' });
  await d.getByRole('button', { name: 'Post poll' }).click();
  const poll = (p) => p.getByRole('group', { name: 'Poll: Is the workload OK?' });
  await poll(page).getByText(/Anonymous: nobody sees who chose what · Closes /).waitFor();
  await kim.goto(`${B}/chat/${ch}`);
  await poll(kim).getByRole('button', { name: /^Too much: 0 votes/ }).click();
  await poll(kim).getByRole('button', { name: 'Too much: 1 vote', pressed: true }).waitFor();
  await poll(page).getByRole('button', { name: 'Too much: 1 vote', pressed: false }).waitFor(); // live, and not Olivia's choice
  if (await poll(page).getByText('Kim Park').count()) throw new Error('names shown');
  if (await poll(page).locator('.poll-names').count()) throw new Error('names line');
  await page.screenshot({ path: `${SP}/shots/chat-poll-anon.png` });
});
const poll = (p) => p.getByRole('group', { name: 'Poll: Is the workload OK?' });
await step('Kim’s own choice stays marked after a reload; Olivia votes too and both counts show', async () => {
  await kim.reload();
  await poll(kim).getByRole('button', { name: 'Too much: 1 vote', pressed: true }).waitFor();
  await poll(page).getByRole('button', { name: /^Yes: 0 votes/ }).click();
  await poll(kim).getByRole('button', { name: 'Yes: 1 vote', pressed: false }).waitFor();
  await poll(kim).getByRole('button', { name: 'Too much: 1 vote', pressed: true }).waitFor(); // (still hers, through the live update)
  await poll(kim).getByText(/2 people voted/).waitFor();
});
await step('a poll closing in a minute closes live for Kim, and Olivia gets the result in the bell', async () => {
  const m = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { poll: { question: 'Coffee run?', options: ['Yes', 'No'], closes_at: Date.now() + 62e3 } })).body;
  const p = kim.getByRole('group', { name: 'Poll: Coffee run?' });
  await p.waitFor();
  await p.getByRole('button', { name: /^Yes: 0 votes/ }).click();
  await p.getByText(/· Closes /).waitFor();
  await p.getByText(/^Closed ·/).waitFor({ timeout: 100e3 }); // (no reload)
  if (!(await p.getByRole('button', { name: /^No: 0 votes/ }).isDisabled())) throw new Error('still open');
  await page.goto(`${B}/drive`);
  const bellBtn = page.getByRole('button', { name: /Notifications/ }).first();
  await bellBtn.click();
  await page.getByText('Poll closed: Coffee run?').waitFor();
  await page.getByText('Yes 1, No 0 · 1 person voted').waitFor();
  if (!m.id) throw new Error('no poll');
});
await step('“Others can add options”: Kim adds Madrid, Olivia sees it live and votes for it', async () => {
  await page.goto(`${B}/chat/${ch}`);
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const d = page.getByRole('dialog', { name: 'Create a poll' });
  await d.getByLabel('Question').fill('Where for the offsite?');
  await d.getByLabel('Option 1').fill('Lisbon');
  await d.getByLabel('Option 2').fill('Porto');
  await d.getByLabel(/Others can add options/).check();
  await d.getByRole('button', { name: 'Post poll' }).click();
  const kp = kim.getByRole('group', { name: 'Poll: Where for the offsite?' });
  await kp.getByLabel('Add an option to: Where for the offsite?').fill('Madrid');
  await kp.getByRole('button', { name: 'Add', exact: true }).click();
  const op = page.getByRole('group', { name: 'Poll: Where for the offsite?' });
  await op.getByRole('button', { name: /^Madrid: 0 votes/ }).click();
  await kp.getByRole('button', { name: /^Madrid: 1 vote/ }).waitFor();
  await kp.getByText('Olivia Owner').waitFor(); // (not anonymous: who chose it)
  // A poll that doesn't let others: no box.
  if (await page.getByLabel('Add an option to: Is the workload OK?').count()) throw new Error('box on a fixed poll');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
