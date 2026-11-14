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
let kim, list;
await step('a list with open and done tasks', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Party prep' })).body.id;
  for (const title of ['Pick a date', 'Book the venue', 'Order cake']) await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title });
  const t = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
  const tasks = Array.isArray(t) ? t : t.tasks;
  await api(page, 'PATCH', `/tasks/tasks/${tasks.find((x) => x.title === 'Pick a date').id}`, { done: true });
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
});
await step('⋮ → Send by email: the open tasks as a checklist, not the done one', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Send by email, with completed' }).waitFor();
  await page.getByRole('menuitem', { name: 'Send by email', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Party prep' });
  await d.waitFor({ timeout: 30000 });
  const msg = d.getByRole('textbox', { name: 'Message' });
  await msg.getByText('☐ Book the venue').waitFor();
  await msg.getByText('☐ Order cake').waitFor();
  if (await msg.getByText('Pick a date').count()) throw new Error('done task included');
  const href = await msg.getByRole('link').first().getAttribute('href');
  if (href !== `${B}/tasks/${list}`) throw new Error(`link ${href}`);
  await page.screenshot({ path: `${SP}/shots/list-email.png` });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.locator('.mail-list').getByText('Party prep', { exact: true }).click({ timeout: 40000 });
  await kim.frameLocator('iframe.mail-html').getByText('☐ Order cake').waitFor();
});
await step('with completed: the done one comes too, struck through', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Send by email, with completed' }).click();
  const msg = page.getByRole('dialog', { name: 'Party prep' }).getByRole('textbox', { name: 'Message' });
  await msg.getByText('Done', { exact: true }).waitFor({ timeout: 30000 });
  await msg.locator('s', { hasText: 'Pick a date' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
