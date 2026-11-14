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
let kim;
const dialog = () => page.getByRole('dialog', { name: 'Forwarding' });
await step('Forwarding: an address gets a code; typing it turns forwarding on', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await page.getByRole('button', { name: 'Forwarding' }).click();
  await dialog().getByLabel('Forward a copy of all incoming mail to').fill('kim@acme.com');
  await dialog().getByRole('button', { name: 'Send confirmation code' }).click();
  await dialog().getByText('A confirmation code was sent to').waitFor();
  const code = await until(async () => {
    const list = (await api(kim, 'GET', '/mail/messages?folder=INBOX')).body.messages || [];
    const m = list.find((x) => /Confirm forwarding/.test(x.subject));
    if (!m) return null;
    return /Confirmation code: (\d{6})/.exec((await api(kim, 'GET', `/mail/messages/${m.uid}?folder=INBOX`)).body.text)?.[1];
  }, 30000);
  await dialog().getByLabel('Confirmation code').fill('000000' === code ? '111111' : '000000');
  await dialog().getByRole('button', { name: 'Confirm' }).click();
  await page.getByText('That code isn’t right').waitFor();
  await dialog().getByLabel('Confirmation code').fill(code);
  await dialog().getByRole('button', { name: 'Confirm' }).click();
  await page.getByText('Mail is now forwarded to kim@acme.com').waitFor();
  if (!(await dialog().getByRole('checkbox', { name: /Forward a copy of incoming mail to kim@acme.com/ }).isChecked())) throw new Error('not on');
  await page.screenshot({ path: `${SP}/shots/forwarding.png` });
});
await step('archive Workspace’s copy: mail arrives for Kim, and Olivia’s copy is in Archive', async () => {
  await dialog().getByLabel('Workspace’s copy').selectOption('archive');
  await page.getByText('Saved', { exact: true }).waitFor();
  await dialog().getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /Forwarding.*On/ }).waitFor();
  await new Promise((r) => setTimeout(r, 4000)); // the mail server picks up the new rule
  if ((await api(kim, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Status report', text: 'All good' })).status !== 200) throw new Error('send');
  await until(async () => ((await api(page, 'GET', '/mail/messages?folder=Archive')).body.messages || []).some((m) => m.subject === 'Status report'), 30000);
  await until(async () => ((await api(kim, 'GET', '/mail/messages?folder=INBOX')).body.messages || []).some((m) => m.subject === 'Status report'), 30000);
  if (((await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages || []).some((m) => m.subject === 'Status report')) throw new Error('in the Inbox too');
});
await step('Admin: keep forwarding inside the company', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const box = page.getByRole('checkbox', { name: 'Let people forward their mail automatically to addresses outside the company' });
  if (!(await box.isChecked())) throw new Error('should start on');
  await box.uncheck();
  await page.getByText('Mail is now only forwarded within the company').waitFor();
  await page.goto(B + '/mail');
  await page.getByRole('button', { name: /Forwarding.*On/ }).click();
  await dialog().getByRole('button', { name: 'Change address' }).click();
  await dialog().getByText('Your company only allows forwarding to its own addresses.').waitFor();
  await dialog().getByLabel('Forward a copy of all incoming mail to').fill('someone@globex.example');
  await dialog().getByRole('button', { name: 'Send confirmation code' }).click();
  await page.getByText('Your company only allows forwarding to its own addresses').last().waitFor();
});
await step('Remove forwarding', async () => {
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  await dialog().getByRole('button', { name: 'Remove forwarding' }).click();
  await page.getByText('Forwarding removed').waitFor();
  await dialog().getByLabel('Forward a copy of all incoming mail to').waitFor();
  await dialog().getByRole('button', { name: 'Close' }).click();
  if (await page.getByRole('button', { name: /Forwarding.*On/ }).count()) throw new Error('pill left');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
