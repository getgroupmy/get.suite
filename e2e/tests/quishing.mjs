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
const QRCode = (await import('module')).createRequire(`${ROOT}/web/package.json`)('qrcode');
const qrPng = (await QRCode.toBuffer('https://evil.example/login', { width: 240 })).toString('base64');
const { PDFDocument, StandardFonts } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
/** A one-page PDF with some text, and the QR code on it when asked. */
const pdf = async (withQr) => {
  const d = await PDFDocument.create();
  const page = d.addPage([595, 842]);
  page.drawText('Your invoice is ready. Scan the code to pay.', { x: 50, y: 780, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
  if (withQr) page.drawImage(await d.embedPng(Buffer.from(qrPng, 'base64')), { x: 50, y: 500, width: 200, height: 200 });
  return Buffer.from(await d.save()).toString('base64');
};
const PLAIN = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
/** An email with an inline picture or an attached one. */
const put = (from, subject, { inline = null, attached = null, pdfFile = null } = {}) => page.evaluate(async ([f, s, inl, att, pdfB64]) => {
  const b = 'BOUNDARY42';
  const parts = [`--${b}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Scan to verify your account.</p>${inl ? `<p><img src="data:image/png;base64,${inl}" alt="code"></p>` : ''}\r\n`];
  if (pdfB64) parts.push(`--${b}\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdfB64}\r\n`);
  if (att) parts.push(`--${b}\r\nContent-Type: image/png; name="scan.png"\r\nContent-Disposition: attachment; filename="scan.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${att}\r\n`);
  const body = `From: ${f}\r\nTo: olivia@acme.com\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}@x>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join('')}--${b}--\r\n`;
  return (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' }, body })).status;
}, [from, subject, inline, attached, pdfFile]);
const open = async (subject) => {
  await page.goto(`${B}/mail/INBOX`);
  await page.locator('.msg-subject', { hasText: subject }).first().click();
  await page.frameLocator('iframe[title="Message"]').getByText('Scan to verify your account.').waitFor();
};
const banner = () => page.locator('.mail-reader').getByText('This email has a QR code in it.', { exact: false });
await step('a QR code in a picture of an email from outside: a warning (inline, or attached)', async () => {
  for (const [f, s, o] of [['"IT Desk" <it@helpdesk.example>', 'Inline code', { inline: qrPng }], ['"IT Desk" <it@helpdesk.example>', 'Attached code', { attached: qrPng }],
    ['"IT Desk" <it@helpdesk.example>', 'Just a picture', { inline: PLAIN, attached: PLAIN }], ['"Raj Kumar" <raj@acme.com>', 'Code from a colleague', { inline: qrPng }]]) {
    const st = await put(f, s, o);
    if (st >= 300) throw new Error(`upload ${st}`);
  }
  await open('Inline code');
  await banner().waitFor();
  await page.screenshot({ path: `${SP}/shots/quishing.png` });
  await axe(page, 'qr banner');
  await open('Attached code');
  await banner().waitFor();
});
await step('no warning for ordinary pictures, or a QR code from a colleague', async () => {
  for (const s of ['Just a picture', 'Code from a colleague']) {
    await open(s);
    await page.waitForTimeout(1500);
    if (await banner().count()) throw new Error(`warned: ${s}`);
  }
});
await step('a QR code in an attached PDF: a warning that says so; a PDF without one: none', async () => {
  for (const [s, withQr] of [['Invoice with code', true], ['Invoice without code', false]]) {
    const st = await put('"Billing" <billing@vendor.example>', s, { pdfFile: await pdf(withQr) });
    if (st >= 300) throw new Error(`upload ${st}`);
  }
  await open('Invoice with code');
  await page.locator('.mail-reader').getByText('This email has a QR code in it (in an attached PDF).').waitFor({ timeout: 20000 });
  await open('Invoice without code');
  await page.waitForTimeout(3000);
  if (await banner().count() || await page.locator('.mail-reader').getByText(/has a QR code/).count()) throw new Error('warned about a PDF without a code');
});
await step('Admin → Company settings: refuse email with programs attached (on and off)', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const box = page.getByRole('checkbox', { name: 'Refuse email with programs or scripts attached' });
  await box.check();
  await page.getByText('Email with programs attached is now refused').waitFor();
  await axe(page, 'company settings');
  if (!(await api(page, 'GET', '/orgs/current')).body.block_programs) throw new Error('not saved');
  await box.uncheck();
  await page.getByText('Email with programs attached is accepted again (with a warning)').waitFor();
});
await step('Security checkup suggests refusing programs, and its button turns it on', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  const item = page.getByRole('listitem').filter({ hasText: 'Email with programs attached is let in' });
  await item.waitFor({ timeout: 20000 });
  await item.getByRole('button', { name: 'Turn it on' }).click();
  await item.waitFor({ state: 'detached' });
  if (!(await api(page, 'GET', '/orgs/current')).body.block_programs) throw new Error('not on');
  await api(page, 'PATCH', '/orgs/current', { block_programs: false });
});
await step('a program refused at the door shows in Admin → Email: Turned away, and in the Email log', async () => {
  const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
  await api(page, 'PATCH', '/orgs/current', { block_programs: true });
  await page.waitForTimeout(9000); // the mail container picks up the list within 5 seconds; Rspamd re-reads it
  const mx = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'mx.sender-test.example' });
  let refused = false;
  try {
    await mx.sendMail({ from: 'it@helpdesk-test.example', to: 'olivia@acme.com', envelope: { from: 'relay@acme.com', to: 'olivia@acme.com' }, subject: 'Tool', text: 'Run it.', attachments: [{ filename: 'tool.exe', content: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]) }] });
  } catch (e) { refused = /Programs and scripts/.test(String(e.response || e.message)); }
  if (!refused) throw new Error('not refused');
  await page.goto(`${B}/admin?tab=email`);
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Turned away in the last 7 days' }) });
  await card.getByText(/Programs or scripts attached: \d+/).waitFor();
  await card.getByRole('table', { name: 'Latest turned away' }).getByText('olivia@acme.com').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/turned-away.png` });
  await axe(page, 'turned away');
  await api(page, 'PATCH', '/orgs/current', { block_programs: false });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
