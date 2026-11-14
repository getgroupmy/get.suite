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
let ch, kim;
await step('setup: a channel and a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Morning all' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await p.getByText('Morning all').waitFor(); }
});
await step('write a message, schedule it for tomorrow morning: it waits, Kim sees nothing', async () => {
  await page.getByRole('textbox', { name: 'Message' }).fill('Standup moved to 10:30 today');
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow morning/ }).click();
  await page.getByText(/^Scheduled for tomorrow at 8:00/).waitFor();
  if (await page.getByRole('textbox', { name: 'Message' }).inputValue()) throw new Error('box not cleared');
  await page.getByRole('button', { name: /^🕒 1 scheduled message · next tomorrow at 8:00/ }).waitFor();
  await page.waitForTimeout(500);
  if (await kim.getByText('Standup moved to 10:30 today').count()) throw new Error('Kim sees it');
  if (await page.locator('.msg', { hasText: 'Standup moved to 10:30 today' }).count()) throw new Error('posted');
  await page.screenshot({ path: `${SP}/shots/chat-scheduled.png` });
});
await step('the list: Send now posts it for everyone', async () => {
  await page.getByRole('button', { name: /^🕒 1 scheduled message/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Scheduled messages' });
  await dlg.getByText(/^Sends tomorrow at 8:00/).waitFor();
  await dlg.getByRole('button', { name: 'Send now' }).click();
  await dlg.getByText('Nothing is waiting to be sent here.').waitFor();
  await kim.locator('.msg', { hasText: 'Standup moved to 10:30 today' }).waitFor();
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  if (await page.getByRole('button', { name: /scheduled message/ }).count()) throw new Error('bar should go');
});
await step('pick a date and time; delete it from the list', async () => {
  await page.getByRole('textbox', { name: 'Message' }).fill('Happy Friday');
  await page.getByRole('button', { name: 'Schedule message' }).click();
  await page.getByRole('menuitem', { name: 'Pick date and time…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Schedule message' });
  const t = new Date(Date.now() + 3 * 864e5);
  await dlg.getByLabel('Date').fill(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  await dlg.getByLabel('Time').fill('16:45');
  await dlg.getByRole('button', { name: 'Schedule' }).click();
  await page.getByText(/^Scheduled for .* at 4:45/).waitFor();
  await page.getByRole('button', { name: /^🕒 1 scheduled message/ }).click();
  const list = page.getByRole('dialog', { name: 'Scheduled messages' });
  await list.getByText('Happy Friday').waitFor();
  await list.getByRole('button', { name: 'Delete' }).click();
  await list.getByText('Nothing is waiting to be sent here.').waitFor();
  await list.getByRole('button', { name: 'Close' }).first().click();
});
await step('one due in half a minute is sent by the server on its own', async () => {
  const r = await api(page, 'POST', `/chat/channels/${ch}/scheduled`, { body: 'Sent by itself', send_at: Date.now() + 31e3 });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await page.getByRole('button', { name: /^🕒 1 scheduled message/ }).waitFor();
  await kim.locator('.msg', { hasText: 'Sent by itself' }).waitFor({ timeout: 60000 });
  await until(async () => (await page.getByRole('button', { name: /scheduled message/ }).count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
