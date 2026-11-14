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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
const z = new JSZip(); z.file('Contract.pdf', 'pdf bytes here'); z.file('photos/site/front.jpg', 'jpgjpg'); z.file('photos/back.jpg', 'jpg'); z.file('__MACOSX/photos/._back.jpg', 'junk');
const zipBuf = await z.generateAsync({ type: 'nodebuffer' });
const dlg = () => page.getByRole('dialog');
await step('a zip attachment opens to show what is inside', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Site files', text: 'Zipped.', attachments: [{ filename: 'Site files.zip', content: zipBuf }] });
  await refreshUntil(page, inboxRow('Site files'));
  await inboxRow('Site files').click();
  await page.getByRole('link', { name: /Site files\.zip/ }).click();
  const list = dlg().getByRole('list', { name: 'Inside the zip' });
  await list.waitFor();
  const items = await list.locator('li').allInnerTexts();
  const names = items.map((t) => t.split('\n')[0].trim());
  if (JSON.stringify(names) !== JSON.stringify(['Contract.pdf', 'photos', 'back.jpg', 'site', 'front.jpg'])) throw new Error(JSON.stringify(items));
  await dlg().getByText('3 files in 2 folders').waitFor();
  if (items.some((t) => /MACOSX/.test(t))) throw new Error('junk shown');
});
await step('saved to Drive, Extract here unpacks it into a folder with the same layout', async () => {
  await dlg().getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByText('Saved Site files.zip to Drive').waitFor();
  await page.getByRole('button', { name: 'Show', exact: true }).last().click();
  await page.waitForURL(/\/drive\/folder\//);
  await page.getByText('Site files.zip', { exact: true }).first().dblclick();
  await dlg().getByRole('list', { name: 'Inside the zip' }).waitFor();
  await dlg().getByRole('button', { name: 'Extract here' }).click();
  await page.getByText('Unpacked 3 files into “Site files”').waitFor();
  await page.getByRole('button', { name: 'Show', exact: true }).last().click();
  await page.getByText('Contract.pdf', { exact: true }).first().waitFor();
  await page.getByText('photos', { exact: true }).first().dblclick();
  await page.getByText('back.jpg', { exact: true }).first().waitFor();
  await page.getByText('site', { exact: true }).first().waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
