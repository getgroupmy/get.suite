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
const kim = await mk('kim');
let fid, token;
await step('Send → Email: the form goes out; who has answered; a reminder for the rest', async () => {
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 90000);
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  // New mailboxes are known to the mail server a few seconds later.
  await signIn(kim, 'kim@acme.com');
  await until(async () => (await api(kim, 'GET', '/mail/folders')).status === 200, 90000);
  const f = (await api(page, 'POST', '/forms', { title: 'Lunch order' })).body;
  fid = f.id || f.form?.id; token = f.token || f.form?.token;
  await page.goto(`${B}/forms/${fid}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Send form' });
  await dlg.getByLabel('To').fill('kim@acme.com, lee@acme.com');
  await dlg.getByLabel('Message (optional)').fill('Order by noon, please.');
  await dlg.getByRole('button', { name: 'Send', exact: true }).click();
  await dlg.getByText('Sent to 2 · 0 answered').waitFor({ timeout: 30000 });
  // Kim answers.
  await signIn(kim, 'kim@acme.com');
  await until(async () => ((await api(kim, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).some((m) => m.subject === 'Lunch order'), 60000);
  const r = await api(kim, 'POST', `/public/forms/${token}`, { answers: {} });
  if (r.status >= 300) throw new Error(JSON.stringify(r));
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await dlg.getByText('Sent to 2 · 1 answered').waitFor();
  await dlg.getByRole('list', { name: 'Sent to' }).getByText('kim@acme.com').waitFor();
  await dlg.getByRole('button', { name: "Remind 1 who haven't answered" }).click();
  await page.getByText('Reminded 1 person').waitFor();
  await dlg.getByText(/reminded/).waitFor();
  await page.screenshot({ path: `${SP}/shots/formsend.png` });
});
await step('Link and QR code', async () => {
  const dlg = page.getByRole('dialog', { name: 'Send form' });
  await dlg.getByRole('tab', { name: 'Link and QR code' }).click();
  const img = dlg.getByRole('img', { name: /QR code for .*\/f\// });
  await img.waitFor();
  if (!(await img.evaluate((i) => i.complete && i.naturalWidth >= 200))) throw new Error('no QR image');
  await dlg.getByRole('link', { name: 'Download QR code' }).waitFor();
});
await step('remind automatically a day before it closes (needs a closing date)', async () => {
  const dlg = page.getByRole('dialog', { name: 'Send form' });
  await dlg.getByRole('tab', { name: 'Email' }).click();
  const box = dlg.getByLabel(/Remind those who haven't answered a day before it closes/);
  if (!(await box.isDisabled())) throw new Error('should need a closing date');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await api(page, 'PUT', `/forms/${fid}`, { close_at: Date.now() + 3 * 864e5 });
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await box.check();
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  if (!(await page.getByRole('dialog', { name: 'Send form' }).getByLabel(/Remind those who haven't answered/).isChecked())) throw new Error('not kept');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
