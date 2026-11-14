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
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
await step('an email becomes a task on My tasks', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Quote for Globex', text: 'Can you send the quote by Friday?' });
  await refreshUntil(page, inboxRow('Quote for Globex'));
  await inboxRow('Quote for Globex').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText('Added to My tasks').waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  const d = page.getByRole('complementary', { name: 'Task details' });
  if ((await d.getByLabel('Task', { exact: true }).inputValue()) !== 'Quote for Globex') throw new Error('title');
  await d.getByRole('link', { name: /Email from Raj Kumar/ }).waitFor();
});
await step('after the email is archived, the task still opens it', async () => {
  await page.goto(`${B}/mail`);
  await inboxRow('Quote for Globex').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Archived', { exact: true }).waitFor();
  await page.goto(`${B}/tasks`);
  await page.locator('.task-title', { hasText: 'Quote for Globex' }).click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Email from Raj Kumar/ }).click();
  await page.waitForURL(/\/mail\/[^/?]+\/\d+/);
  if (/INBOX/.test(page.url())) throw new Error('still inbox ' + page.url());
  await page.locator('.reader').getByText('Can you send the quote by Friday?').waitFor();
});
await step('a chat message becomes a task that links back to it', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: '**Book** the meeting room for Monday\nthanks!' });
  await page.goto(`${B}/chat/${ch}`);
  const msg = page.locator('.msg', { hasText: 'the meeting room for Monday' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText('Added to My tasks').waitFor();
  await page.goto(`${B}/tasks`);
  await page.locator('.task-title', { hasText: /^Book the meeting room for Monday$/ }).click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Chat message from Olivia Owner/ }).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  await page.locator('.msg', { hasText: 'the meeting room for Monday' }).waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
