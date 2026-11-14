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
let doc, sheet;
const draft = () => page.locator('.ProseMirror .doc-email');
await step('@email puts in an email draft; To, Subject and the text are written in the document', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Q3 figures' })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch comms' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Note to Kim:');
  await page.keyboard.press('Enter');
  await page.keyboard.type('@ema');
  await page.getByRole('listbox', { name: 'People, dates and files' }).getByRole('option', { name: /Email draft/ }).waitFor();
  await page.keyboard.press('Enter');
  await draft().waitFor();
  await page.keyboard.type('Hi Kim, the numbers are in: ');
  await page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, `${B}/sheets/${sheet.id}`);
  await draft().locator('.doc-filechip', { hasText: 'Q3 figures' }).waitFor();
  await draft().getByLabel('To').fill('kim@acme.com');
  await draft().getByLabel('Subject').fill('Q3 numbers');
  await page.screenshot({ path: `${SP}/shots/emaildraft-doc.png` });
  if (await page.locator('.ProseMirror', { hasText: '@ema' }).count()) throw new Error('the @ text was left');
});
await step('kept after a reload', async () => {
  await page.waitForTimeout(1500);
  await page.reload();
  await draft().waitFor();
  const to = await draft().getByLabel('To').inputValue(), subj = await draft().getByLabel('Subject').inputValue();
  if (to !== 'kim@acme.com' || subj !== 'Q3 numbers') throw new Error(`fields: ${to} / ${subj}`);
  await draft().locator('.doc-email-body', { hasText: 'Hi Kim, the numbers are in' }).waitFor();
});
await step('Open in Mail opens it as a new message, ready to send; Kim gets it', async () => {
  const [mail] = await Promise.all([page.context().waitForEvent('page'), draft().getByRole('button', { name: 'Open in Mail' }).click()]);
  const d = mail.getByRole('dialog', { name: 'Q3 numbers' });
  await d.waitFor({ timeout: 30000 });
  if (await d.getByLabel('Subject').inputValue() !== 'Q3 numbers') throw new Error('no subject');
  await until(async () => (await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('kim@acme.com'));
  await d.getByRole('textbox', { name: 'Message' }).getByText('Hi Kim, the numbers are in').waitFor();
  const href = await d.getByRole('textbox', { name: 'Message' }).getByRole('link', { name: /Q3 figures/ }).getAttribute('href');
  if (href !== `${B}/sheets/${sheet.id}`) throw new Error(`link ${href}`);
  await mail.screenshot({ path: `${SP}/shots/emaildraft-mail.png` });
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await mail.getByRole('button', { name: 'Share (can view) and send' }).click(); // the sheet linked in it isn't shared with Kim yet
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const kctx = await browser.newContext(); const k = await kctx.newPage();
  await signIn(k, 'kim@acme.com');
  await k.locator('.mail-list').getByText('Q3 numbers', { exact: true }).waitFor({ timeout: 40000 });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
