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
await step('outside the company: a notice names who it goes to, new ones marked; a contact is not new', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com, pat@partner.example, new@stranger.example');
  await page.getByLabel('Subject').click();
  const note = page.locator('.compose-outside');
  await note.getByText('2 recipients outside Acme Trading:').waitFor({ timeout: 10000 });
  await note.getByText('pat@partner.example').waitFor();
  if ((await note.getByText('(new)').count()) !== 2) throw new Error('both new');
  if (await note.getByText('olivia@acme.com').count()) throw new Error('a company address listed');
  await page.screenshot({ path: `${SP}/shots/mail-outside.png` });
  const c = await api(page, 'POST', '/contacts', { name: 'Pat Partner', email: 'pat@partner.example' });
  if (c.status !== 201) throw new Error(`contact ${c.status}`);
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com, pat@partner.example');
  await page.getByLabel('Subject').click();
  await note.getByText('Going outside Acme Trading:').waitFor();
  await until(async () => (await note.getByText('(new)').count()) === 0);
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').click();
  await note.waitFor({ state: 'detached' });
});
await step('Admin asks before mail goes outside: Send asks, Go back keeps the message, Send sends it', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  await page.getByRole('checkbox', { name: 'Ask before sending a message to anyone outside the company' }).check();
  await page.getByText('Mail now asks before a message goes outside the company').waitFor();
  await page.goto(B + '/mail');
  const run = Date.now().toString(36);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com, pat@partner.example');
  await page.getByLabel('Subject').fill(`Quote ${run}`);
  await page.locator('.compose-outside').waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Send outside Acme Trading?' });
  await dlg.getByText('pat@partner.example').waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-outside-ask.png` });
  await dlg.getByRole('button', { name: 'Go back' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.getByLabel('Subject').waitFor(); // still writing
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await dlg.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 2 recipients/).waitFor({ timeout: 20000 });
  // Inside only: no question.
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(`Inside ${run}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 1 recipient/).waitFor({ timeout: 20000 });
  if (await dlg.isVisible()) throw new Error('asked for an inside message');
});
await step('Admin activity lists the message sent outside after being asked', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Activity' }).or(page.getByRole('button', { name: 'Activity' })).first().click();
  await page.getByText('Sent an email outside the company (after being asked)').first().waitFor({ timeout: 10000 });
  await page.getByText(/Quote /).first().waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-outside-activity.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
