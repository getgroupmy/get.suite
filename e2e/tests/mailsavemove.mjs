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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
await step('Save to Drive, then Move… from the note: filed where it belongs', async () => {
  const invoices = (await api(page, 'POST', '/files/folder', { name: 'Invoices 2027' })).body;
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Invoice 4411', text: 'Attached.', attachments: [{ filename: 'invoice-4411.pdf', content: PDF }] });
  await refreshUntil(page, inboxRow('Invoice 4411'));
  await inboxRow('Invoice 4411').click();
  await page.getByRole('button', { name: 'Save invoice-4411.pdf to Drive' }).first().click();
  await page.getByText('Saved invoice-4411.pdf to Drive').waitFor();
  await page.getByRole('button', { name: 'Move…' }).click();
  const move = page.getByRole('dialog', { name: /Move “invoice-4411\.pdf”/ });
  await move.getByLabel('Find a folder').fill('invoices');
  await move.getByRole('list', { name: 'Folders found' }).getByRole('button').filter({ hasText: 'Invoices 2027' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await move.waitFor({ state: 'detached' });
  await page.getByText('Moved invoice-4411.pdf').waitFor();
  const inFolder = (await api(page, 'GET', `/files?view=mine&parent=${invoices.id}`)).body.map((f) => f.name);
  if (!inFolder.includes('invoice-4411.pdf')) throw new Error(inFolder.join('|'));
  await page.getByRole('button', { name: 'Show' }).last().click();
  await page.waitForURL(new RegExp(`/drive/folder/${invoices.id}`));
});

await step('the same from the Attachments list in the sidebar', async () => {
  const receipts = (await api(page, 'POST', '/files/folder', { name: 'Receipts 2027' })).body;
  await page.goto(`${B}/mail`);
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Receipt 88', text: 'Attached.', attachments: [{ filename: 'receipt-88.pdf', content: PDF }] });
  await refreshUntil(page, inboxRow('Receipt 88'));
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Attachments' });
  const row = d.getByRole('list', { name: 'Attachments' }).locator('li', { hasText: 'receipt-88.pdf' });
  await row.getByRole('button', { name: 'Save receipt-88.pdf to Drive' }).click();
  await page.getByText('Saved receipt-88.pdf to Drive').waitFor();
  await page.getByRole('button', { name: 'Move…' }).click();
  const move = page.getByRole('dialog', { name: /Move “receipt-88\.pdf”/ });
  await move.getByLabel('Find a folder').fill('receipts');
  await move.getByRole('list', { name: 'Folders found' }).getByRole('button').filter({ hasText: 'Receipts 2027' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await move.waitFor({ state: 'detached' });
  await page.getByText('Moved receipt-88.pdf').waitFor();
  const inFolder = (await api(page, 'GET', `/files?view=mine&parent=${receipts.id}`)).body.map((f) => f.name);
  if (!inFolder.includes('receipt-88.pdf')) throw new Error(inFolder.join('|'));
});

await step('a message saved as a PDF: Move… files it too', async () => {
  const letters = (await api(page, 'POST', '/files/folder', { name: 'Letters 2027' })).body;
  await page.goto(`${B}/mail`);
  await inboxRow('Invoice 4411').click();
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Save to Drive as PDF' }).click();
  await page.getByText(/Saved to Drive: Saved emails \/ Invoice 4411/).waitFor();
  await page.getByRole('button', { name: 'Move…' }).click();
  const move = page.getByRole('dialog', { name: /Move “Invoice 4411/ });
  await move.getByLabel('Find a folder').fill('letters');
  await move.getByRole('list', { name: 'Folders found' }).getByRole('button').filter({ hasText: 'Letters 2027' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await move.waitFor({ state: 'detached' });
  const inFolder = (await api(page, 'GET', `/files?view=mine&parent=${letters.id}`)).body.map((f) => f.name);
  if (!inFolder.some((n) => /^Invoice 4411.*\.pdf$/.test(n))) throw new Error(inFolder.join('|'));
});
await step('several saved as documents at once: Move… files them all', async () => {
  const archive = (await api(page, 'POST', '/files/folder', { name: 'Mail archive 2027' })).body;
  await page.goto(`${B}/mail`);
  await page.getByLabel('Select Invoice 4411').first().check();
  await page.getByLabel('Select Receipt 88').first().check();
  await page.locator('.mail-bulk').getByRole('button', { name: 'Save to Drive as documents' }).click();
  await page.getByText('Saved 2 documents to Drive: Saved emails').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Move…' }).click();
  const move = page.getByRole('dialog', { name: /Move 2 items/ });
  await move.getByRole('list', { name: 'Recent folders' }).getByRole('button').first().waitFor(); // (the folders used above)
  await move.getByLabel('Find a folder').fill('mail archive');
  await move.getByRole('list', { name: 'Folders found' }).getByRole('button').filter({ hasText: 'Mail archive 2027' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await move.waitFor({ state: 'detached' });
  await page.getByText('Moved 2 files').waitFor();
  const inFolder = (await api(page, 'GET', `/files?view=mine&parent=${archive.id}`)).body;
  if (inFolder.length !== 2 || !inFolder.every((f) => f.kind === 'doc')) throw new Error(JSON.stringify(inFolder.map((f) => [f.name, f.kind])));
});

if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
