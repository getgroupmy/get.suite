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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
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
  const u = await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam Sender', password: 'password123' });
  if (u.status !== 201) throw new Error(JSON.stringify(u));
});

let form;
await step('turn on email me each response', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Lunch order', questions: [{ id: 'food', type: 'choice', title: 'What would you like?', options: ['Pizza', 'Salad'] }, { id: 'note', type: 'short', title: 'Anything else' }] })).body;
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const box = page.getByLabel(/Email me each response/);
  await box.waitFor();
  if (await box.isChecked()) throw new Error('on already');
  await box.check();
  await page.getByText('Each new response will be emailed to olivia@acme.com').waitFor();
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  if (!(await page.getByLabel(/Email me each response/).isChecked())) throw new Error('not kept');
  await page.screenshot({ path: `${SP}/shots/formemail-settings.png` });
});

await step('a response arrives as an email', async () => {
  const sam = await mk('sam');
  await sam.goto(B);
  await sam.getByLabel('Email address').fill('sam@acme.com');
  await sam.getByLabel('Password').fill('password123');
  await sam.getByRole('button', { name: 'Sign in' }).click();
  await sam.getByRole('link', { name: 'Mail' }).waitFor();
  await sam.goto(`${B}/f/${form.token}`);
  await sam.getByLabel('Pizza').check();
  await sam.getByLabel('Anything else').fill('Extra cheese');
  await sam.getByRole('button', { name: 'Submit' }).click();
  await sam.getByText(/recorded|Thanks/i).first().waitFor();
  await page.goto(`${B}/mail`);
  const row = page.locator('.mail-list').getByText('New response to “Lunch order” from Sam Sender', { exact: true });
  await refreshUntil(page, row);
  await row.click();
  await page.getByText('What would you like?: Pizza').waitFor();
  await page.getByText('Anything else: Extra cheese').waitFor();
  await page.getByText(/All responses: .*\/forms\//).waitFor();
  await page.screenshot({ path: `${SP}/shots/formemail-mail.png` });
});

await step('turning it off stops the emails', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Email me each response/).uncheck();
  await page.getByText('No more response emails').waitFor();
  const r = await api(page, 'GET', `/forms/${form.id}`);
  if (r.body.email_me !== false) throw new Error('still on');
});

console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
