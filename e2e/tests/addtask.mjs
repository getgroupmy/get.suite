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
  // In the list, the message is marked as having a task to do (only it).
  await page.locator('.msg-row', { hasText: 'Quote for Globex' }).getByLabel('1 task to do:').waitFor();
  if ((await page.getByLabel(/tasks? to do:/).count()) !== 1) throw new Error('one message is marked');
  await inboxRow('Quote for Globex').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Archived', { exact: true }).waitFor();
  await page.goto(`${B}/tasks`);
  await page.locator('.task-title', { hasText: 'Quote for Globex' }).click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Email from Raj Kumar/ }).click();
  await page.waitForURL(/\/mail\/[^/?]+\/\d+/);
  if (/INBOX/.test(page.url())) throw new Error('still inbox ' + page.url());
  await page.locator('.reader').getByText('Can you send the quote by Friday?').waitFor();
  // The email shows its open task beside Add to Tasks (wherever it has moved to), and opens it.
  await page.locator('.reader-actions').getByRole('button', { name: '1 task to do about this email' }).click();
  await page.getByRole('menuitem', { name: /^Quote for Globex/ }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Email from Raj Kumar/ }).waitFor();
});
await step('an email whose subject names a day: its task is due that day, titled as the subject', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Re: Figures needed by friday', text: 'The board pack goes out Monday.' });
  await page.goto(`${B}/mail`);
  await refreshUntil(page, inboxRow('Re: Figures needed by friday'));
  await inboxRow('Re: Figures needed by friday').click();
  await page.locator('.reader-actions').getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText('Added to My tasks').waitFor();
  const fri = new Date(); fri.setDate(fri.getDate() + (((12 - fri.getDay()) % 7) || 7));
  const friday = `${fri.getFullYear()}-${String(fri.getMonth() + 1).padStart(2, '0')}-${String(fri.getDate()).padStart(2, '0')}`;
  const made = [];
  for (const l of (await api(page, 'GET', '/tasks/lists')).body.lists) made.push(...(await api(page, 'GET', `/tasks/lists/${l.id}/tasks`)).body);
  const t = made.find((x) => x.title === 'Re: Figures needed by friday');
  const plain = made.find((x) => x.title === 'Quote for Globex');
  if (!t || t.due !== friday || !plain || plain.due) throw new Error(JSON.stringify(made.map((x) => [x.title, x.due])));
});
await step('a chat message becomes a task that links back to it', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: '**Book** the meeting room for Monday\nthanks!' });
  await page.goto(`${B}/chat/${ch}`);
  const msg = page.locator('.msg', { hasText: 'the meeting room for Monday' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText('Added to My tasks').waitFor();
  await msg.getByRole('button', { name: '1 task to do about this message' }).waitFor(); // (marked at once)
  // The message says "for Monday": the task is due that day, with its title as written.
  const mon = new Date(); mon.setDate(mon.getDate() + (((8 - mon.getDay()) % 7) || 7));
  const monday = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
  const made = [];
  for (const l of (await api(page, 'GET', '/tasks/lists')).body.lists) made.push(...(await api(page, 'GET', `/tasks/lists/${l.id}/tasks`)).body);
  const booked = made.find((t) => t.title === 'Book the meeting room for Monday');
  if (!booked || booked.due !== monday) throw new Error(JSON.stringify(made.map((t) => [t.title, t.due])));
  await page.goto(`${B}/tasks`);
  await page.locator('.task-title', { hasText: /^Book the meeting room for Monday$/ }).click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Chat message from Olivia Owner/ }).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  await page.locator('.msg', { hasText: 'the meeting room for Monday' }).waitFor();
  // Back in the conversation (loaded afresh), the message still carries its task, and opens it.
  await page.locator('.msg', { hasText: 'the meeting room for Monday' }).getByRole('button', { name: '1 task to do about this message' }).click();
  await page.getByRole('menuitem', { name: /^Book the meeting room for Monday/ }).click();
  await page.waitForURL(/\/tasks\/.+\?task=/);
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('link', { name: /Chat message from Olivia Owner/ }).waitFor();
});
await step('Tasks → Use for Add to Tasks: a chat message then goes to the list chosen', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Follow-ups' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Use for Add to Tasks' }).click();
  await page.getByText('Add to Tasks (in Mail, Chat and Notes) now uses “Follow-ups”').waitFor();
  const ch = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'office').id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Send the invoice to Globex' });
  await page.goto(`${B}/chat/${ch}`);
  const msg = page.locator('.msg', { hasText: 'Send the invoice to Globex' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText('Added to Follow-ups').waitFor();
  const titles = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body.map((t) => t.title);
  if (!titles.includes('Send the invoice to Globex')) throw new Error(titles.join());
  // Back to the first list.
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Stop using for Add to Tasks' }).click();
  await page.getByText('Add to Tasks uses “My tasks” again').waitFor();
});
await step('a shared list ⋮ → Email the list’s people: a new email to everyone on it but you', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kimlist', domain: 'acme.com', name: 'Kim List', password: 'password123' })).body;
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Trade fair' })).body.id;
  const m = await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kim.id] });
  if (m.status >= 300) throw new Error(JSON.stringify(m.body));
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Email the list’s people' }).click();
  await page.waitForURL(/\/mail/);
  const compose = page.getByRole('dialog', { name: /New message|Trade fair/ });
  const to = await compose.getByLabel('To', { exact: true }).inputValue();
  if (!/Kim List <kimlist@acme\.com>/.test(to) || /olivia@/.test(to)) throw new Error(`To: ${to}`);
  if ((await compose.getByLabel('Subject').inputValue()) !== 'Trade fair') throw new Error('subject');
});
await step('a task’s details → Send by email: a new email with the task, its due date, notes and steps', async () => {
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Printing' })).body.id;
  const t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Order the banners', due: '2026-12-01', notes: 'Two metres wide' })).body;
  await api(page, 'POST', `/tasks/tasks/${t.id}/steps`, { title: 'Get a quote' });
  await page.goto(`${B}/tasks/${list}?task=${t.id}`);
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('button', { name: 'Send by email' }).click();
  await page.waitForURL(/\/mail/);
  const compose = page.getByRole('dialog', { name: /New message|Order the banners/ });
  await compose.getByLabel('Subject').waitFor();
  if ((await compose.getByLabel('Subject').inputValue()) !== 'Order the banners') throw new Error('subject');
  const body = compose.getByRole('textbox', { name: 'Message' });
  await body.getByText('Two metres wide').waitFor();
  await body.getByText(/Due .*Dec.*2026 · In Printing/).waitFor();
  await body.getByText('☐ Get a quote').waitFor();
  await body.getByRole('link', { name: new RegExp(`/tasks/${list}`) }).waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
