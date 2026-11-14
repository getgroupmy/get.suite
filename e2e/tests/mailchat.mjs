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
const longText = `Hi Olivia,\n\nThe Northwind order is confirmed: 40 units, shipping Friday.\n\n${'More details follow here. '.repeat(20)}`;
let kim;
await step('Share in Chat: More → Share in Chat…, pick a channel, add a note', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const s = await api(kim, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Northwind order', text: longText });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  await page.goto(`${B}/mail`);
  const row = page.getByText('Northwind order').first();
  await row.waitFor({ timeout: 30000 });
  await row.click();
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Share in Chat…' }).click();
  const d = page.getByRole('dialog', { name: 'Share in Chat' });
  await d.getByLabel('Conversation').selectOption({ label: '# general' });
  await d.getByLabel('Message (optional)').fill('Kim, can you check stock?');
  await d.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByText('Shared in # general').waitFor();
  await d.waitFor({ state: 'detached' });
});
await step('everyone in the channel sees the card, and Show more opens the rest', async () => {
  const general = (await api(kim, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByText('Kim, can you check stock?').waitFor();
  const card = kim.getByRole('group', { name: 'Email: Northwind order' });
  await card.waitFor();
  const t = await card.textContent();
  if (!/From\s*Kim Park/.test(t) || !/To\s*Olivia Owner|To\s*olivia@acme.com/.test(t) || !/40 units, shipping Friday/.test(t)) throw new Error(t);
  if (t.includes('More details follow here. '.repeat(20).trim())) throw new Error('the whole text shows before Show more');
  await card.getByRole('button', { name: 'Show more' }).click();
  await card.getByRole('button', { name: 'Show less' }).waitFor();
  if (!(await card.textContent()).includes('More details follow here. More details follow here.')) throw new Error('not the rest');
  await kim.screenshot({ path: `${SP}/shots/mailchat-card.png` });
});
await step('search finds the shared email by its subject and text', async () => {
  await kim.getByLabel('Search messages').fill('shipping friday');
  await kim.keyboard.press('Enter');
  const res = kim.getByRole('list', { name: 'Search results' });
  await res.getByText('Northwind order').waitFor();
  await kim.getByLabel('Search messages').fill('northwind');
  await kim.keyboard.press('Enter');
  await until(async () => (await res.locator('mark').allInnerTexts()).includes('Northwind'));
});
await step('forwarding it to a direct message carries the card', async () => {
  const kimId = (await api(kim, 'GET', '/auth/me')).body.user.id;
  await api(page, 'POST', '/chat/dm', { user_id: kimId });
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  const msg = page.locator('.msg', { hasText: 'Kim, can you check stock?' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Forward' }).click();
  const d = page.getByRole('dialog', { name: 'Forward message' });
  await d.getByLabel('To').selectOption({ label: 'Kim Park' });
  await d.getByRole('button', { name: 'Forward' }).click();
  await page.getByText('Forwarded to Kim Park').waitFor();
  const dm = (await api(kim, 'GET', '/chat/channels')).body.channels.find((c) => c.dm_key && c.dm_name === 'Olivia Owner').id;
  await kim.goto(`${B}/chat/${dm}`);
  await kim.getByRole('group', { name: 'Email: Northwind order' }).waitFor();
});
await step('Open in Mail: Kim (who sent it) opens it from the card; Lee, who never had it, is told', async () => {
  const general = (await api(kim, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByRole('group', { name: 'Email: Northwind order' }).getByRole('button', { name: 'Open in Mail' }).click();
  await kim.waitForURL(/\/mail\/Sent\/\d+/);
  await kim.locator('.reader').getByText('Northwind order').first().waitFor();
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  const lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/chat/${general}`);
  await lee.getByRole('group', { name: 'Email: Northwind order' }).getByRole('button', { name: 'Open in Mail' }).click();
  await lee.getByText('This email isn’t in your mailbox').waitFor();
  if (!lee.url().includes('/chat/')) throw new Error('left Chat');
});
await step('Reply by email: a reply to the sender, in the same email conversation', async () => {
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('group', { name: 'Email: Northwind order' }).getByRole('button', { name: 'Reply by email' }).click();
  const d = page.getByRole('dialog', { name: 'Re: Northwind order' }).or(page.getByRole('dialog', { name: 'New message' }));
  await d.waitFor();
  if (await d.getByLabel('Subject').inputValue() !== 'Re: Northwind order') throw new Error(await d.getByLabel('Subject').inputValue());
  await d.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Stock is fine, go ahead.');
  const toVal = await d.getByLabel('To', { exact: true }).inputValue();
  if (!toVal.includes('kim@acme.com')) throw new Error(`to: ${toVal}`);
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const orig = (await api(kim, 'GET', '/mail/messages?folder=Sent')).body.messages.find((m) => m.subject === 'Northwind order');
  const got = await until(async () => (await api(kim, 'GET', '/mail/messages?folder=INBOX')).body.messages?.find((m) => m.subject === 'Re: Northwind order'), 30000);
  const full = (await api(kim, 'GET', `/mail/messages/${got.uid}?folder=INBOX`)).body;
  const om = (await api(kim, 'GET', `/mail/messages/${orig.uid}?folder=Sent`)).body.messageId;
  if (!full.references.includes(om)) throw new Error(`${JSON.stringify(full.references)} vs ${om}`);
  if (!/Stock is fine/.test(full.text)) throw new Error(full.text);
});
await step('several at once: tick two, Share in Chat…, each its own card', async () => {
  for (const n of ['Invoice March', 'Invoice April']) await api(kim, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: n, text: `${n} attached.` });
  await page.goto(`${B}/mail`);
  for (const n of ['Invoice March', 'Invoice April']) { const box = page.getByLabel(`Select ${n}`, { exact: true }); await box.waitFor({ timeout: 30000 }); await box.check(); }
  await page.getByRole('button', { name: 'Share in Chat…' }).click();
  const d = page.getByRole('dialog', { name: 'Share 2 emails in Chat' });
  await d.getByLabel('Conversation').selectOption({ label: '# general' });
  await d.getByLabel('Message (optional)').fill('Two invoices for March and April');
  await d.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByText('2 emails shared in # general').waitFor();
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('group', { name: 'Email: Invoice March' }).waitFor();
  await page.getByRole('group', { name: 'Email: Invoice April' }).waitFor();
  if ((await page.getByText('Two invoices for March and April').count()) !== 1) throw new Error('the note once');
});
await step('Add to Tasks on a shared email with no message of its own: called after its subject, with who sent it', async () => {
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  const msg = page.locator('.msg', { has: page.getByRole('group', { name: 'Email: Invoice April' }) });
  await msg.hover();
  await msg.getByRole('button', { name: 'Add to Tasks' }).click();
  await page.getByText(/^Added to /).waitFor();
  const lists = (await api(page, 'GET', '/tasks/lists')).body.lists;
  const tasks = (await api(page, 'GET', `/tasks/lists/${lists[0].id}/tasks`)).body;
  const t = tasks.find((x) => x.title === 'Invoice April');
  if (!t || !/^Email from Kim Park: Invoice April/.test(t.notes || '')) throw new Error(JSON.stringify(tasks.map((x) => [x.title, x.notes])));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
