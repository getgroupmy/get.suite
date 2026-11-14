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
const list = () => page.locator('.mail-list');
const side = () => page.locator('.subnav');
const inFolder = async (f) => ((await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(f)}`)).body.messages || []);
await step('drag a message onto a folder: it moves there (with Undo)', async () => {
  for (const s of ['Invoice 1042', 'Invoice 1043', 'Team lunch', 'Contract draft']) if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: s, text: 'x' })).status !== 200) throw new Error('send');
  if ((await api(page, 'POST', '/mail/folders', { name: 'Invoices' })).status >= 300) throw new Error('folder');
  if ((await api(page, 'POST', '/mail/labels', { name: 'Legal', color: '#d93025' })).status >= 300) throw new Error('label');
  await until(async () => (await inFolder('INBOX')).length >= 4, 40000);
  await page.reload();
  await list().getByText('Invoice 1042', { exact: true }).waitFor({ timeout: 30000 });
  await list().locator('li', { hasText: 'Invoice 1042' }).dragTo(side().getByRole('button', { name: /^Invoices/ }));
  await page.getByText('Moved to Invoices').waitFor();
  await until(async () => (await inFolder('Invoices')).some((m) => m.subject === 'Invoice 1042'));
  await page.locator('.toast', { hasText: 'Moved to Invoices' }).getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await inFolder('INBOX')).some((m) => m.subject === 'Invoice 1042') && !(await inFolder('Invoices')).length);
});
await step('drag the ticked messages together onto Archive', async () => {
  await list().locator('li', { hasText: 'Invoice 1042' }).waitFor();
  await page.getByRole('checkbox', { name: 'Select Invoice 1042' }).check();
  await page.getByRole('checkbox', { name: 'Select Invoice 1043' }).check();
  await list().locator('li', { hasText: 'Invoice 1043' }).dragTo(side().getByRole('button', { name: /^Archive/ }));
  await page.getByText('Moved 2 messages to Archive').waitFor();
  await until(async () => (await inFolder('Archive')).length === 2);
  if ((await inFolder('INBOX')).some((m) => /Invoice/.test(m.subject))) throw new Error('left behind');
});
await step('drag a message onto a label: it gets the label', async () => {
  await list().locator('li', { hasText: 'Contract draft' }).dragTo(side().getByRole('button', { name: /^Legal/ }));
  await page.getByText('Labelled Legal').waitFor();
  await until(async () => (await inFolder('INBOX')).find((m) => m.subject === 'Contract draft')?.labels?.length === 1);
  await list().locator('li', { hasText: 'Contract draft' }).getByText('Legal').waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
