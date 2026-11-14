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
const dlg = () => page.getByRole('dialog');
await step('clicking a picture attachment opens it in the viewer, with the others a click or arrow key away', async () => {
  await smtp.sendMail({ from: 'Raj Kumar <raj@acme.com>', to: 'olivia@acme.com', subject: 'Site visit', text: 'Photos and notes attached.',
    attachments: [{ filename: 'photo.png', content: PNG }, { filename: 'bundle.rar', content: 'Rar! not really' }, { filename: 'notes.txt', content: 'Hello from the notes' },
      { filename: 'report.pdf', content: PDF }, { filename: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }] });
  await refreshUntil(page, inboxRow('Site visit'));
  await inboxRow('Site visit').click();
  await page.getByRole('link', { name: /photo\.png/ }).click();
  await dlg().getByRole('img', { name: 'photo.png' }).waitFor();
  await until(() => dlg().getByRole('img', { name: 'photo.png' }).evaluate((i) => i.complete && i.naturalWidth === 2));
  await dlg().getByText('1 of 3').waitFor();
  await page.keyboard.press('ArrowRight');
  await dlg().getByText('2 of 3').waitFor();
  const frame = page.frameLocator('iframe[title="notes.txt"]');
  await frame.getByText('Hello from the notes').waitFor();
  await dlg().getByRole('button', { name: 'Next file' }).click();
  await page.locator('iframe[title="report.pdf"]').waitFor();
  await page.keyboard.press('ArrowRight');
  await dlg().getByText('1 of 3').waitFor(); // round to the start, skipping the zip and the svg
  await page.keyboard.press('ArrowLeft');
  await dlg().getByText('3 of 3').waitFor();
});
await step('the viewer downloads and saves to Drive; it closes with Escape', async () => {
  await dlg().getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByText('Saved report.pdf to Drive').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg().getByRole('link', { name: 'Download' }).click()]);
  if (dl.suggestedFilename() !== 'report.pdf') throw new Error(dl.suggestedFilename());
  await page.keyboard.press('Escape');
  await dlg().waitFor({ state: 'detached' });
  await page.getByRole('link', { name: /Site visit|photo\.png/ }).first().waitFor();
});
await step('kinds that could run script, or that the browser can’t show, still download', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /bundle\.rar/ }).click()]);
  if (dl.suggestedFilename() !== 'bundle.rar') throw new Error(dl.suggestedFilename());
  if (await dlg().count()) throw new Error('no viewer for a rar');
  const href = await page.getByRole('link', { name: /logo\.svg/ }).getAttribute('href');
  const h = await page.evaluate(async (u) => { const r = await fetch(u + '&view'); return [r.headers.get('content-type'), r.headers.get('content-disposition')]; }, href);
  if (h[0] !== 'application/octet-stream' || !h[1].startsWith('attachment')) throw new Error('svg ' + h);
  const t = await page.evaluate(async (u) => { const r = await fetch(u.replace(/attachments\/\d+/, 'attachments/2') + '&view'); return [r.headers.get('content-type'), r.headers.get('content-security-policy'), r.headers.get('x-content-type-options')]; }, href);
  if (t[0] !== 'text/plain; charset=utf-8' || !/sandbox/.test(t[1]) || t[2] !== 'nosniff') throw new Error('txt ' + t);
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
