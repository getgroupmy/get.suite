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
let kim, dm, kimId;
const line = (p) => p.locator('.typing-line').first();
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
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${dm.id}`); await p.getByLabel('Message', { exact: true }).waitFor(); }
  await page.waitForTimeout(500);
});
await step('Kim types: Olivia sees “Kim Park is typing…”', async () => {
  await kim.getByLabel('Message', { exact: true }).pressSequentially('Hello the', { delay: 40 });
  await until(async () => (await line(page).innerText()) === 'Kim Park is typing…');
  if ((await line(kim).innerText()) !== '') throw new Error('not to yourself');
  await page.screenshot({ path: `${SP}/shots/typing.png` });
});
await step('sending clears it straight away', async () => {
  await kim.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Hello the').first().waitFor();
  await until(async () => (await line(page).innerText()) === '', 1500);
});
await step('clearing the box clears it; otherwise it fades after a few seconds', async () => {
  await kim.getByLabel('Message', { exact: true }).pressSequentially('abc', { delay: 30 });
  await until(async () => (await line(page).innerText()) === 'Kim Park is typing…');
  await kim.getByLabel('Message', { exact: true }).fill('');
  await kim.getByLabel('Message', { exact: true }).press('Backspace');
  await kim.getByLabel('Message', { exact: true }).type('x'); await kim.getByLabel('Message', { exact: true }).press('Backspace');
  await until(async () => (await line(page).innerText()) === '', 3000);
  await kim.waitForTimeout(2600);
  await kim.getByLabel('Message', { exact: true }).pressSequentially('z');
  await until(async () => (await line(page).innerText()) === 'Kim Park is typing…');
  await until(async () => (await line(page).innerText()) === '', 9000);
});
await step('in a thread, it shows in the thread', async () => {
  await page.getByText('Hello the').first().hover();
  await page.getByRole('button', { name: /Reply in thread/ }).first().click();
  await kim.getByText('Hello the').first().hover();
  await kim.getByRole('button', { name: /Reply in thread/ }).first().click();
  await kim.waitForTimeout(2600);
  await kim.getByLabel('Reply', { exact: true }).pressSequentially('sure', { delay: 40 });
  await until(async () => (await page.locator('aside .typing-line').innerText()) === 'Kim Park is typing…');
  if ((await page.locator('.typing-line').first().innerText()) !== '') throw new Error('not in the main conversation');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
