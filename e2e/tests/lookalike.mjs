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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
const put = (from, subject) => page.evaluate(async ([f, s]) => (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' },
  body: `From: ${f}\r\nTo: olivia@acme.com\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}@x>\r\nDate: ${new Date().toUTCString()}\r\n\r\nPlease change the bank details we pay into.\r\n` })).status, [from, subject]);
const open = async (subject) => {
  await page.goto(`${B}/mail/INBOX`);
  await page.locator('.msg-subject', { hasText: subject }).first().click();
  await page.locator('.mail-reader').getByText('Please change the bank details').waitFor();
};
await step('an email from acrne.com warns that it looks like the company’s own acme.com', async () => {
  await api(page, 'POST', '/contacts', { name: 'Initech billing', email: 'billing@initech.com' });
  for (const [f, s] of [['"Accounts" <accounts@acrne.com>', 'Urgent invoice'], ['"Billing" <billing@lnitech.com>', 'New bank details'], ['"Billing" <billing@initech.com>', 'Monthly statement']]) {
    const st = await put(f, s);
    if (st >= 300) throw new Error(`upload ${st}`);
  }
  await open('Urgent invoice');
  await page.locator('.mail-reader').getByText('Careful: acrne.com looks like acme.com, but it isn’t.').waitFor();
  await page.locator('.mail-reader').getByText(/acme\.com is Acme Trading’s own domain/).waitFor();
  await page.screenshot({ path: `${SP}/shots/lookalike.png` });
  await axe(page, 'lookalike banner');
});
await step('one like a domain you deal with (a contact’s) warns too; the real one doesn’t', async () => {
  await open('New bank details');
  await page.locator('.mail-reader').getByText('Careful: lnitech.com looks like initech.com, but it isn’t.').waitFor();
  await page.locator('.mail-reader').getByText(/You deal with initech\.com/).waitFor();
  await open('Monthly statement');
  if (await page.locator('.mail-reader').getByText(/looks like/).count()) throw new Error('warned about the real one');
});
await step('replies that would go to another site than the email came from are pointed out', async () => {
  const st = await page.evaluate(async () => (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' },
    body: `From: "Initech billing" <billing@initech.com>\r\nReply-To: billing.initech@freemail.example\r\nTo: olivia@acme.com\r\nSubject: Updated remittance\r\nMessage-ID: <remit1@x>\r\nDate: ${new Date().toUTCString()}\r\n\r\nPlease change the bank details we pay into.\r\n` })).status);
  if (st >= 300) throw new Error(`upload ${st}`);
  await open('Updated remittance');
  const note = page.locator('.mail-reader').getByText('Careful: replies to this email go to billing.initech@freemail.example, not to billing@initech.com.');
  await note.waitFor();
  await axe(page, 'reply-to banner');
  await page.locator('.mail-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByLabel('To', { exact: true }).waitFor();
  await until(() => page.locator('.compose').evaluate((f) => (f.innerText + [...f.querySelectorAll('input')].map((i) => i.value).join(' ')).includes('billing.initech@freemail.example')));
  await open('Monthly statement');
  if (await page.locator('.mail-reader').getByText(/replies to this email go to/).count()) throw new Error('warned without a Reply-To');
});
await step('“You don’t often get email from …” for an outside address seen for the first time; not once known', async () => {
  for (const [f, s] of [['"New Supplier" <sales@first-time.example>', 'First contact'], ['"Regular" <news@regular.example>', 'Regular one'], ['"Regular" <news@regular.example>', 'Regular two'],
    ['"Kim" <kim@acme.com>', 'From a colleague'], ['"Contact" <pat@known-contact.example>', 'From a contact']]) {
    const st = await put(f, s);
    if (st >= 300) throw new Error(`upload ${st}`);
  }
  await api(page, 'POST', '/contacts', { name: 'Pat Known', email: 'pat@known-contact.example' });
  const note = () => page.locator('.mail-reader .first-contact');
  await open('First contact');
  await note().getByText('You don’t often get email from sales@first-time.example').waitFor();
  await axe(page, 'first contact note');
  for (const s of ['Regular two', 'From a colleague', 'From a contact']) {
    await open(s);
    await page.waitForTimeout(500);
    if (await note().count()) throw new Error(`note on: ${s}`);
  }
});
await step('writing to a lookalike address: a red warning, and Send asks first', async () => {
  await page.goto(`${B}/mail/INBOX`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('accounts@acrne.com');
  await page.getByLabel('Subject').fill('Payment');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Done today.');
  const warn = page.locator('.compose-lookalike');
  await warn.getByText(/acrne\.com looks like acme\.com/).waitFor();
  await axe(page, 'lookalike in compose');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Check the address' });
  await ask.getByText(/accounts@acrne\.com is on acrne\.com, which looks like acme\.com but isn’t/).waitFor();
  await ask.getByRole('button', { name: 'Go back' }).click();
  await ask.waitFor({ state: 'detached' });
  // An ordinary outside address: no such warning.
  await page.getByLabel('To', { exact: true }).fill('someone@unrelated-shop.example');
  await page.waitForTimeout(1200);
  if (await warn.count()) throw new Error('warned about an ordinary address');
  await page.keyboard.press('Escape');
});
await step('an email from outside about changed bank details: confirm by phone; the same from a colleague: nothing', async () => {
  await open('New bank details'); // from the lookalike lnitech.com, "Please change the bank details we pay into."
  const w = page.locator('.mail-reader').getByText('This email says bank or payment details have changed.');
  await w.waitFor();
  await page.locator('.mail-reader').getByText(/other things about this email are unusual too/).waitFor();
  await page.locator('.mail-reader').getByText(/confirm it by phone on a number you already have/).waitFor();
  await axe(page, 'payment warning');
  const st = await put('"Kim" <kim@acme.com>', 'Supplier update');
  if (st >= 300) throw new Error(`upload ${st}`);
  await open('Supplier update');
  if (await w.count()) throw new Error('warned about a colleague');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
