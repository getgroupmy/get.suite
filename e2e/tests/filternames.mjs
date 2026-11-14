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
const box = async (folder = 'INBOX') => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(folder)}`)).body?.messages || [];
const sendWith = async (subject, files) => {
  const r = await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: 'Here.', attachments: files });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
};
let invoice, photo;

await step('search filename:pdf, then Create a filter: an attachment-name condition, applied to mail already there', async () => {
  invoice = (await upload('Invoice 12.pdf', '%PDF-1.4\n')).id;
  photo = (await upload('lunch.jpg', 'jpeg')).id;
  await sendWith('Invoice for October', [invoice]);
  await sendWith('Lunch photo', [photo]);
  await until(async () => (await box()).length === 2, 30000);
  await page.reload();
  const search = page.getByLabel('Search mail');
  await search.fill('filename:pdf');
  await search.press('Enter');
  await page.waitForURL((u) => new URL(u).searchParams.get('q') === 'filename:pdf');
  await page.locator('.mail-list').getByText('Invoice for October').waitFor();
  await page.getByRole('button', { name: 'Create a filter' }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  if (await ed.getByLabel('Condition 1 field').inputValue() !== 'filename' || await ed.getByLabel('Condition 1 value').inputValue() !== 'pdf') throw new Error('condition');
  if (!(await ed.getByLabel('Condition 1 field').locator('option:checked').innerText()).includes('Attachment name')) throw new Error('field name');
  await ed.getByRole('checkbox', { name: 'Move to' }).check();
  await ed.getByLabel('Folder').selectOption({ label: 'New folder…' });
  await ed.getByLabel('New folder name').fill('Invoices');
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await axe(page, 'filter');
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved, and applied to 1 message already in the Inbox').waitFor();
  await until(async () => (await box('Invoices')).some((m) => m.subject === 'Invoice for October'));
  if (!(await box()).some((m) => m.subject === 'Lunch photo') || (await box()).some((m) => m.subject === 'Invoice for October')) throw new Error('wrong ones moved');
});

await step('new mail with a PDF goes to Invoices as it arrives; a picture stays in the Inbox', async () => {
  await page.waitForTimeout(3000); // the mail server's filters are rewritten a moment later
  const again = (await upload('INVOICE-13.PDF', '%PDF-1.4\n')).id;
  await sendWith('Invoice for November', [again]);
  await sendWith('More photos', [photo]);
  await until(async () => (await box('Invoices')).some((m) => m.subject === 'Invoice for November'), 30000);
  await until(async () => (await box()).some((m) => m.subject === 'More photos'), 30000);
  if ((await box()).some((m) => m.subject === 'Invoice for November')) throw new Error('also in the Inbox');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
