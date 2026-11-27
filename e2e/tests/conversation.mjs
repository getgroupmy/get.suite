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
await step('a reply from Sent and the next message: the conversation shows both around the one being read', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await smtp.sendMail({ from: 'Kim Park <kim@acme.com>', to: 'olivia@acme.com', subject: 'Quote for chairs', text: 'Here is the quote.', date: new Date(Date.now() - 5 * 60e3) });
  await refreshUntil(page, inboxRow('Quote for chairs'));
  let r;
  for (let i = 0; i < 40; i++) { // Kim's mailbox is ready a few seconds after the account is made
    r = await api(page, 'POST', '/mail/send', { to: 'kim@acme.com', subject: 'Re: Quote for chairs', text: 'Can you do 10% off?' });
    if (r.status === 200) break;
    await page.waitForTimeout(1000);
  }
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  await page.waitForTimeout(1100);
  await smtp.sendMail({ from: 'Kim Park <kim@acme.com>', to: 'olivia@acme.com', subject: 'RE: Quote for chairs', text: 'Yes, 10% off.' });
  await refreshUntil(page, inboxRow('RE: Quote for chairs'));
  await inboxRow('Quote for chairs').click();
  await page.getByRole('button', { name: /^▸ Conversation: 2 later messages$/ }).click();
  const conv = page.getByRole('list', { name: 'Conversation' });
  await conv.getByText('Re: Quote for chairs', { exact: true }).waitFor();
  await conv.locator('li', { has: page.getByText('Re: Quote for chairs', { exact: true }) }).getByText('Sent', { exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/conversation.png` });
});
await step('opening one from Sent goes there', async () => {
  await page.getByRole('list', { name: 'Conversation' }).getByText('Re: Quote for chairs', { exact: true }).click();
  await page.locator('.reader-subject', { hasText: 'Re: Quote for chairs' }).waitFor();
  if (!/\/mail\/Sent\/\d+/.test(page.url())) throw new Error(page.url());
  await page.getByRole('button', { name: /^▸ Conversation: 1 earlier, 1 later message/ }).waitFor();
});
await step('the conversation bar: every button reachable on a phone (it wraps), and no accessibility problems, light and dark', async () => {
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  const bar = page.locator('.conversation-bar');
  await bar.getByRole('button', { name: /^Mark all read/ }).waitFor();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(AXE);
    const bad = await page.evaluate(async () => (await window.axe.run(document.querySelector('.conversation'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`));
    if (bad.length) throw new Error(`${scheme}: ${bad.join(' | ')}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  for (const b of await bar.getByRole('button').all()) {
    const r = await b.boundingBox();
    if (!r || r.x < 0 || r.x + r.width > 390) throw new Error(`${await b.innerText()} is off the screen: ${JSON.stringify(r)}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});
await step('Mark all read marks the conversation\'s unread messages read', async () => {
  const btn = page.getByRole('button', { name: /^Mark all read \(1\)$/ });
  await btn.click();
  await btn.waitFor({ state: 'detached' });
  const kims = (await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent('RE: Quote for chairs')}`)).body.messages.find((m) => m.subject === 'RE: Quote for chairs');
  if (!kims?.seen) throw new Error(JSON.stringify(kims));
});
await step('Print all prints the whole conversation, oldest first, on one page', async () => {
  await page.getByRole('button', { name: 'Print all' }).click();
  const frame = page.locator('iframe.print-frame').last();
  await frame.waitFor({ state: 'attached' });
  await until(async () => /Yes, 10% off/.test(await frame.evaluate((f) => f.contentDocument?.body?.innerText || '')));
  const text = await frame.evaluate((f) => f.contentDocument.body.innerText);
  if (!/^Quote for chairs\n+3 messages/.test(text)) throw new Error(text.slice(0, 200));
  const at = (t) => text.indexOf(t);
  if (!(at('Can you do 10% off?') > 0 && at('Can you do 10% off?') < at('Yes, 10% off.'))) throw new Error(text);
  if ((text.match(/Subject|Quote for chairs/g) || []).length < 3) throw new Error('not every message');
});
await step('Forward all starts an email with the whole conversation, oldest first', async () => {
  await page.getByRole('button', { name: 'Forward all' }).click();
  await until(async () => (await page.getByLabel('Subject').inputValue().catch(() => '')) === 'Fwd: Quote for chairs');
  const body = page.getByRole('textbox', { name: 'Message' });
  await until(async () => /Yes, 10% off/.test(await body.innerText()));
  const text = await body.innerText();
  if ((text.match(/Forwarded message/g) || []).length !== 3) throw new Error(text);
  if (!(text.indexOf('Can you do 10% off?') < text.indexOf('Yes, 10% off.'))) throw new Error(text);
  const draft = page.getByRole('dialog', { name: /Fwd: Quote for chairs|New message/ }).first();
  await draft.getByRole('button', { name: 'Close' }).first().click();
});
await step('Download conversation (.zip) gives every message of the conversation as an .eml, oldest first', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download conversation (.zip)' }).click()]);
  if (!/^Quote for chairs \(conversation of 3\)\.zip$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()));
  const names = Object.keys(zip.files).sort();
  if (names.length !== 3 || !names.every((n) => n.endsWith('.eml'))) throw new Error(names.join(', '));
  const texts = await Promise.all(names.map((n) => zip.file(n).async('string')));
  if (!texts.some((t) => /Yes, 10% off\./.test(t)) || !texts.some((t) => /Can you do 10% off\?/.test(t))) throw new Error('messages missing');
});
await step('Save all to Drive keeps the whole conversation as one PDF in Saved emails', async () => {
  await page.getByRole('button', { name: 'Save all to Drive' }).click();
  const toast = page.locator('.toast', { hasText: /Saved to Drive: Saved emails \/ Quote for chairs \(conversation of 3, \d{4}-\d\d-\d\d\)\.pdf/ });
  await toast.waitFor();
  await toast.getByRole('button', { name: 'Show' }).click();
  await page.getByText(/Quote for chairs \(conversation of 3/).first().waitFor();
});
await step('Archive all moves the conversation\'s Inbox messages to Archive (from a reply in Sent, which stays)', async () => {
  const sent = (await api(page, 'GET', '/mail/folders')).body.find?.((f) => f.special === '\\Sent')?.path || 'Sent';
  const mine = (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(sent)}&q=${encodeURIComponent('Quote for chairs')}`)).body.messages[0];
  await page.goto(`${B}/mail/${encodeURIComponent(sent)}/${mine.uid}`);
  const btn = page.getByRole('button', { name: /^Archive all \(2\)$/ });
  await btn.click();
  await page.getByText('Archived 2 messages of this conversation').waitFor();
  await btn.waitFor({ state: 'detached' });
  const left = (await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent('Quote for chairs')}`)).body.messages;
  if (left.length) throw new Error(`still in the Inbox: ${left.map((m) => m.subject)}`);
  await page.locator('.reader-subject', { hasText: 'Re: Quote for chairs' }).waitFor(); // (the reply in Sent stays open)
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
