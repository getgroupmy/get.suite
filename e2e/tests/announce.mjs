import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let kim, rob, ch;
await step('an announcements channel where only Kim (and admins) post', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'rob', domain: 'acme.com', name: 'Rob Reader', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'news' })).body;
  await page.goto(`${B}/chat/${ch.id}`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const d = page.getByRole('dialog', { name: '#news' });
  await d.getByLabel(/Only some people/).check();
  await d.getByRole('group', { name: 'People who can post' }).or(d.locator('fieldset.people-pick')).first().getByLabel(/Kim Park/).check();
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Only the people chosen (and admins) can post now').waitFor();
});
await step('Rob sees a note instead of the message box; Kim posts; Rob replies in a thread', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  rob = await mk('rob'); await signIn(rob, 'rob@acme.com');
  await kim.goto(`${B}/chat/${ch.id}`);
  await kim.getByLabel('Message', { exact: true }).fill('Office closed on Friday');
  await kim.keyboard.press('Enter');
  await kim.getByText('Office closed on Friday').waitFor();
  await rob.goto(`${B}/chat/${ch.id}`);
  await rob.getByText('Office closed on Friday').waitFor();
  await rob.getByRole('note').getByText(/Only Kim Park \(and admins\) start conversations here/).waitFor();
  if (await rob.getByLabel('Message', { exact: true }).count()) throw new Error('message box shown');
  await rob.locator('.msg', { hasText: 'Office closed on Friday' }).hover();
  await rob.getByRole('button', { name: 'Reply in thread' }).first().click();
  const reply = rob.getByLabel(/Reply/).last();
  await reply.fill('Thanks for the heads-up');
  await reply.press('Enter');
  await kim.getByText(/1 repl/).waitFor({ timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
