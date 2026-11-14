import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});

await step('create-signature', async () => {
  await page.getByRole('button', { name: 'Signature' }).click();
  await page.getByRole('textbox', { name: 'Signature' }).click();
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type('Olivia Owner');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Acme Trading · +971 4 555 0100');
  await page.screenshot({ path: `${SP}/shots/signature-dialog.png` });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: /Signature for .* saved/ }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
});

await step('new-message-has-signature', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.locator('.compose-editor strong', { hasText: 'Olivia Owner' }).waitFor();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Hello from Acme');
  await editor(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Hi Gina, nice to meet you.');
  await page.screenshot({ path: `${SP}/shots/compose-signature.png` });
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-sees-signature', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Hello from Acme' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  await f.getByText('Hi Gina, nice to meet you.').waitFor();
  await f.getByText('Acme Trading · +971 4 555 0100').waitFor();
  const uid = Number(gina.url().split('/').pop());
  const msg = (await api(gina, 'GET', `/mail/messages/${uid}?folder=INBOX`)).body;
  if (!/Hi Gina, nice to meet you\.\n-- \nOlivia Owner\nAcme Trading/.test(msg.text)) throw new Error('plain text: ' + JSON.stringify(msg.text));
  await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Re: Hello from Acme', text: 'Likewise!' });
}, gina);

await step('reply-signature-above-quote', async () => {
  const row = page.locator('.msg-list li', { hasText: 'Re: Hello from Acme' });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.locator('.compose-editor blockquote').waitFor();
  const order = await page.locator('.compose-editor .tiptap').evaluate((el) => {
    const sig = [...el.querySelectorAll('strong')].find((x) => x.textContent === 'Olivia Owner');
    const quote = el.querySelector('blockquote');
    return sig && quote ? sig.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  if (!order) throw new Error('signature is not above the quote');
  await page.getByRole('button', { name: 'Discard draft' }).click();
});

await step('resumed-draft-keeps-one-signature', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('Subject').fill('Draft with signature');
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.locator('.msg-list li', { hasText: 'Draft with signature' }).locator('.msg-row').click();
  await page.locator('.compose-editor strong', { hasText: 'Olivia Owner' }).first().waitFor();
  const n = await page.locator('.compose-editor strong', { hasText: 'Olivia Owner' }).count();
  if (n !== 1) throw new Error(`signature appears ${n} times`);
  await page.getByRole('button', { name: 'Discard draft' }).click();
});

await step('built-in-folders-have-no-menu', async () => {
  // Drafts has no menu; the other built-in folders only offer uploading saved emails.
  if (await page.getByRole('button', { name: 'Options for Drafts' }).count()) throw new Error('Drafts has a menu');
  for (const name of ['Inbox', 'Sent', 'Trash', 'Junk']) {
    await page.locator('.folder-row', { hasText: name }).first().hover();
    await page.getByRole('button', { name: `Options for ${name}` }).click();
    const got = await page.getByRole('menuitem').allTextContents();
    if (!got.some((t) => /Upload emails/.test(t)) || got.some((t) => /Rename|Delete|Notify/.test(t))) throw new Error(`${name} menu: ${got.join(' | ')}`);
    await page.keyboard.press('Escape');
  }
  // The Archive's menu only offers notifications: it can't be renamed or deleted.
  await page.locator('.folder-row', { hasText: 'Archive' }).hover();
  await page.getByRole('button', { name: 'Options for Archive' }).click();
  const items = await page.getByRole('menuitem').allTextContents();
  if (items.some((t) => /Rename|Delete/.test(t))) throw new Error('Archive menu: ' + items.join(' | '));
  await page.keyboard.press('Escape');
});

await step('rename-folder', async () => {
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel(/Folder name/).fill('Projects/Alpha');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: /^Projects \/ Alpha( \d+)?$/ }).waitFor();
  await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'File me in Alpha', text: 'x' });
  let inbox = [];
  for (let i = 0; i < 30 && !inbox.some((m) => m.subject === 'File me in Alpha'); i++) {
    await page.waitForTimeout(500);
    inbox = (await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages;
  }
  const msg = inbox.find((m) => m.subject === 'File me in Alpha');
  await api(page, 'POST', '/mail/messages/move', { folder: 'INBOX', uids: [msg.uid], to: 'Projects/Alpha' });
  await page.getByRole('button', { name: /^Projects \/ Alpha( \d+)?$/ }).click();
  await page.locator('.msg-list li').first().waitFor();
  await page.getByRole('button', { name: 'Options for Projects / Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel(/New name/).fill('Work/Alpha');
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.locator('.toast', { hasText: 'Renamed to Work/Alpha' }).waitFor();
  await page.getByRole('button', { name: /^Work \/ Alpha( \d+)?$/ }).waitFor();
  if (!page.url().includes('Work%2FAlpha')) throw new Error('did not follow the renamed folder: ' + page.url());
  await page.locator('.msg-list li').first().waitFor();
});

await step('delete-folder-moves-mail-to-trash', async () => {
  await page.getByRole('button', { name: 'Options for Work / Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByText(/Its 1 message will be moved to Trash/).waitFor();
  await page.screenshot({ path: `${SP}/shots/delete-folder.png` });
  await page.getByRole('button', { name: 'Delete folder' }).click();
  await page.locator('.toast', { hasText: '1 message moved to Trash' }).waitFor();
  await page.getByRole('button', { name: /^Work \/ Alpha( \d+)?$/ }).waitFor({ state: 'detached', timeout: 5000 }).catch(() => { throw new Error('folder still listed'); });
  await page.getByRole('button', { name: /^Trash/ }).click();
  await page.locator('.msg-list li').first().waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
