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
const thread = (p) => p.getByRole('complementary', { name: 'Thread' });
await step('a thread reply with "Also send to #launch" shows in the conversation too, saying which thread; Kim sees it live', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await api(kim, 'POST', `/chat/channels/${ch}/messages`, { body: 'Which date for the launch?' });
  await kim.goto(`${B}/chat/${ch}`);
  await kim.locator('.msg', { hasText: 'Which date for the launch?' }).waitFor();
  await page.goto(`${B}/chat/${ch}`);
  const msg = page.locator('.msg', { hasText: 'Which date for the launch?' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply in thread' }).click();
  const t = thread(page);
  await t.getByRole('textbox', { name: 'Reply' }).fill('The 3rd works for everyone');
  await t.getByLabel('Also send to #launch').check();
  await t.getByRole('button', { name: 'Send reply' }).click();
  await t.locator('.msg', { hasText: 'The 3rd works for everyone' }).waitFor();
  if (await t.getByLabel('Also send to #launch').isChecked()) throw new Error('still ticked for the next reply');
  // In the conversation, below the message, with a line saying which thread.
  const copy = page.locator('.chat-main .msg, .msg').filter({ hasText: 'Replied to a thread' });
  await copy.getByText('The 3rd works for everyone').waitFor();
  await copy.getByText('“Which date for the launch?” (Kim Park)').waitFor();
  const kc = kim.locator('.msg', { hasText: 'Replied to a thread' });
  await kc.getByText('The 3rd works for everyone').waitFor();
  await kim.locator('.msg', { hasText: 'Which date for the launch?' }).getByText(/1 reply/).waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-also-send.png` });
});
await step('Kim: View thread on the copy opens the thread', async () => {
  const kc = kim.locator('.msg', { hasText: 'Replied to a thread' });
  await kc.getByRole('button', { name: 'View thread' }).click();
  const t = thread(kim);
  await t.locator('.msg', { hasText: 'Which date for the launch?' }).waitFor();
  await t.locator('.msg', { hasText: 'The 3rd works for everyone' }).waitFor();
  await kim.screenshot({ path: `${SP}/shots/chat-also-send-thread.png` });
});
await step('Olivia changes the copy: the reply in the thread changes too (Kim sees both)', async () => {
  const copy = page.locator('.msg').filter({ hasText: 'Replied to a thread' });
  await copy.hover();
  await copy.getByRole('button', { name: 'Edit message' }).click();
  await copy.getByLabel('Change the message').fill('The 3rd, at 10:00');
  await copy.getByLabel('Change the message').press('Enter');
  await thread(kim).locator('.msg', { hasText: 'The 3rd, at 10:00' }).waitFor();
  await kim.locator('.msg', { hasText: 'Replied to a thread' }).getByText('The 3rd, at 10:00').waitFor();
});
await step('deleting the reply in the thread takes the copy away too', async () => {
  await page.locator('.msg', { hasText: 'Which date for the launch?' }).first().hover();
  await page.locator('.msg', { hasText: 'Which date for the launch?' }).first().getByRole('button', { name: 'Reply in thread' }).click();
  const r = thread(page).locator('.msg', { hasText: 'The 3rd, at 10:00' });
  await r.hover();
  await r.getByRole('button', { name: 'Delete message' }).click();
  await until(async () => !(await page.locator('.msg', { hasText: 'Replied to a thread' }).count()));
  await until(async () => !(await kim.locator('.msg', { hasText: 'Replied to a thread' }).count()));
  await until(async () => !(await thread(kim).locator('.msg', { hasText: 'The 3rd, at 10:00' }).count()));
});
await step('in an announcement channel Kim may only reply in the thread: no tick box', async () => {
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  await api(page, 'PATCH', `/chat/channels/${ch}`, { posters: [me.id] });
  await kim.reload();
  const msg = kim.locator('.msg', { hasText: 'Which date for the launch?' }).first();
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply in thread' }).click();
  await thread(kim).getByRole('textbox', { name: 'Reply' }).waitFor();
  if (await thread(kim).getByLabel('Also send to #launch').count()) throw new Error('offered where Kim can’t post');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
