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
let general;
const box = (p) => p.getByRole('textbox', { name: /^Message/ });
const run = async (p, text) => { await box(p).fill(text); await box(p).press('Enter'); };
const side = (p) => p.locator('aside.subnav');
await step('/remind me to call Kim in 2 hours: a reminder, listed under Reminders with where it was made', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await run(page, '/remind me to call Kim in 2 hours');
  await page.getByText(/^I'll remind you .*: call Kim$/).waitFor();
  if (await box(page).inputValue()) throw new Error('left in the box');
  if ((await api(page, 'GET', `/chat/channels/${general}/messages`)).body.length) throw new Error('posted something');
  await side(page).getByRole('button', { name: /Reminders\s*1/ }).click();
  const list = page.getByRole('list', { name: 'Reminders' });
  await list.getByText('call Kim', { exact: true }).waitFor();
  await list.getByText(/#general · your reminder/).waitFor();
  const r = (await api(page, 'GET', '/chat/reminders')).body[0];
  if (Math.abs(r.at - Date.now() - 2 * 36e5) > 60e3) throw new Error(`at ${new Date(r.at)}`);
  await page.screenshot({ path: `${SP}/shots/chat-remind-list.png` });
});
await step('cancel it from the list', async () => {
  await page.getByRole('button', { name: 'Cancel reminder: call Kim' }).click();
  await page.getByText('Reminder removed').waitFor();
  await page.getByText('No reminders').waitFor();
});
await step('without a time: an error, and the text stays to fix', async () => {
  await page.goto(`${B}/chat/${general}`);
  await run(page, '/remind me to water the plants');
  await page.getByText(/^Say when: \/remind me to call Kim in 2h/).waitFor();
  if (await box(page).inputValue() !== '/remind me to water the plants') throw new Error(await box(page).inputValue());
});
await step('one due in a minute arrives in the bell and opens the conversation', async () => {
  await box(page).fill('/remind stretch your legs in 1 minute');
  await box(page).press('Enter');
  await page.getByText(/^I'll remind you .*: stretch your legs$/).waitFor();
  await page.goto(`${B}/drive`);
  const bellBtn = page.getByRole('button', { name: /Notifications/ }).first();
  await until(async () => /[1-9]/.test(await bellBtn.getAttribute('aria-label') || ''), 100e3);
  await bellBtn.click();
  await page.getByText('Reminder: stretch your legs').click();
  await page.waitForURL(new RegExp(`/chat/${general}`));
  if ((await api(page, 'GET', '/chat/reminders')).body.length) throw new Error('still listed');
});
await step('/remind @kim@acme.com to send the slides in 1 minute: listed for Kim; Kim gets it, from Olivia', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await page.goto(`${B}/chat/${general}`);
  await run(page, '/remind @kim@acme.com to send the slides in 1 minute');
  await page.getByText(/^I'll remind Kim Park .*: send the slides$/).waitFor();
  await side(page).getByRole('button', { name: /Reminders/ }).click();
  await page.getByRole('list', { name: 'Reminders' }).getByText(/#general · for Kim Park/).waitFor();
  const kbell = kim.getByRole('button', { name: /Notifications/ }).first();
  await until(async () => /[1-9]/.test(await kbell.getAttribute('aria-label') || ''), 100e3);
  await kbell.click();
  await kim.getByText('Reminder from Olivia Owner: send the slides').click();
  await kim.waitForURL(new RegExp(`/chat/${general}`));
  await page.getByText('No reminders').waitFor(); // gone from Olivia's list, live
});
await step('/remind me to submit my timesheet every friday 4pm: repeats, listed with how it repeats; cancelling ends it', async () => {
  await page.goto(`${B}/chat/${general}`);
  await run(page, '/remind me to submit my timesheet every friday 4pm');
  await page.getByText(/^I'll remind you .* \(weekly on fri\): submit my timesheet$/).waitFor();
  const r = (await api(page, 'GET', '/chat/reminders')).body.find((x) => x.text === 'submit my timesheet');
  const d = new Date(r.at);
  if (d.getDay() !== 5 || d.getHours() !== 16 || r.at < Date.now()) throw new Error(String(d));
  await side(page).getByRole('button', { name: /Reminders/ }).click();
  const list = page.getByRole('list', { name: 'Reminders' });
  await list.getByText(/#general · your reminder · 🔁 Weekly on Fri/).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-remind-repeat.png` });
  await page.getByRole('button', { name: 'Cancel reminder: submit my timesheet' }).click();
  await page.getByText('No reminders').waitFor();
});
await step('/remind #team to order lunch in 1 minute: posted in #team for everyone (Kim sees it come in)', async () => {
  const team = (await api(page, 'POST', '/chat/channels', { name: 'team' })).body.id;
  await page.goto(`${B}/chat/${general}`);
  await run(page, '/remind #nope to order lunch in 1 hour');
  await page.getByText('You’re not in a channel called #nope').waitFor();
  await run(page, '/remind #team to order lunch in 1 minute');
  await page.getByText(/^I'll post in #team .*: ⏰ Reminder: order lunch$/).waitFor();
  await side(page).getByRole('button', { name: /Reminders/ }).click();
  await page.getByRole('list', { name: 'Reminders' }).getByText(/#team · posted there/).waitFor();
  const kim = await mk('kim2'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${team}`);
  await kim.locator('.msg', { hasText: '⏰ Reminder: order lunch' }).waitFor({ timeout: 100e3 });
  await kim.locator('.msg', { hasText: '⏰ Reminder: order lunch' }).getByText('Olivia Owner').waitFor();
  await page.getByText('No reminders').waitFor();
  await kim.screenshot({ path: `${SP}/shots/chat-remind-channel.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
