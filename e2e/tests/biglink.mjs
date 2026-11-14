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
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, name: "test.acme.com" });
await step('over 25 MB: one click sends the large file as a link; it arrives as a download link', async () => {
  await compose('Plans and video', 'See attached.');
  await page.getByLabel('Attachment files').setInputFiles([{ name: 'walkthrough.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(27 * 1024 * 1024, 1) }, { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('the plan') }]);
  await page.getByText('Attachments are over 25 MB.').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Send the large files as links' }).click();
  if (!(await page.getByLabel('Send walkthrough.mp4 as a link').isChecked())) throw new Error('not ticked');
  if (await page.getByLabel('Send plan.txt as a link').isChecked()) throw new Error('small one ticked');
  await page.getByText('Files sent as links go out as download links').waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await refreshUntil(page, inboxRow('Plans and video'));
  await inboxRow('Plans and video').click();
  const full = await until(async () => {
    const list = (await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages || [];
    const m = list.find((x) => x.subject === 'Plans and video');
    return m && (await api(page, 'GET', `/mail/messages/${m.uid}?folder=INBOX`)).body;
  }, 20000);
  if (JSON.stringify(full.attachments.map((a) => a.filename)) !== '["plan.txt"]') throw new Error(JSON.stringify(full.attachments));
  const token = full.text.match(/\/s\/([\w-]+)/)?.[1];
  if (!token) throw new Error(full.text);
  const pub = await page.context().newPage();
  await pub.goto(`${B}/s/${token}`);
  await pub.getByText('walkthrough.mp4').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
