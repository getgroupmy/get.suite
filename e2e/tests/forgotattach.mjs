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
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
const run = Date.now().toString(36);
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
await step('says attached with nothing attached: asked first; Attach a file opens the picker', async () => {
  await compose(`Report ${run}`, 'Hi, I have attached the report.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Did you mean to attach something?' });
  await dlg.waitFor();
  await dlg.getByText('Your message says “attached”, but nothing is attached.').waitFor();
  await page.screenshot({ path: `${SP}/shots/forgot-attach.png` });
  const chooser = page.waitForEvent('filechooser');
  await dlg.getByRole('button', { name: 'Attach a file' }).click();
  const fc = await chooser;
  await fc.setFiles({ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
  await page.getByText('report.csv').first().waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 1 recipient/).waitFor({ timeout: 20000 });
  if (await dlg.isVisible()) throw new Error('asked again with a file attached');
  await until(async () => (await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent(`Report ${run}`)}`)).body?.messages?.length, 30000);
});
await step('Send anyway sends it as it is; a reply quoting an attachment is not asked about', async () => {
  await compose(`Minutes ${run}`, 'Enclosed are the minutes.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Did you mean to attach something?' });
  await dlg.getByText('“Enclosed”').waitFor();
  await dlg.getByRole('button', { name: 'Send anyway' }).click();
  await page.getByText(/Sent to 1 recipient/).last().waitFor({ timeout: 20000 });
  await until(async () => (await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent(`Minutes ${run}`)}`)).body?.messages?.length, 30000);
  // Reply to the report (which says attached, in the quote): no question.
  await page.goto(`${B}/mail`);
  await row(`Report ${run}`).first().click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Thanks, got it.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 1 recipient/).last().waitFor({ timeout: 20000 });
  if (await dlg.isVisible()) throw new Error('asked about the quoted attachment');
});
await step('Settings: words of your own are asked about; turned off, nothing is asked', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Forgotten attachments' });
  await card.getByLabel('Your own words').fill('Anlage, spec sheet');
  await card.getByRole('button', { name: 'Save words' }).click();
  await page.getByText('Your words are saved').waitFor();
  await page.goto(`${B}/mail`);
  await compose(`Angebot ${run}`, 'Siehe Anlage.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Did you mean to attach something?' });
  await dlg.getByText('Your message says “Anlage”').waitFor();
  await dlg.getByRole('button', { name: 'Close' }).click().catch(() => page.keyboard.press('Escape'));
  await dlg.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Close' }).last().click();
  // Off: a message that says attached goes straight away.
  await page.goto(`${B}/settings`);
  await page.getByRole('region', { name: 'Forgotten attachments' }).getByLabel(/Ask before sending/).uncheck();
  await page.getByText('Saved', { exact: true }).last().waitFor();
  await page.screenshot({ path: `${SP}/shots/forgot-attach-settings.png` });
  await page.goto(`${B}/mail`);
  await compose(`Offer ${run}`, 'I have attached the offer.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Sent to 1 recipient/).last().waitFor({ timeout: 20000 });
  if (await dlg.isVisible()) throw new Error('asked although it is off');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
