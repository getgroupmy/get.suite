import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); } };
const send = async (p, body) => { for (let k = 0; k < 20; k++) { const r = await api(p, 'POST', '/mail/send', body); if (r.status === 200) return r; await p.waitForTimeout(1500); } throw new Error('could not send'); };
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
const inbox = async (folder = 'INBOX') => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(folder)}`)).body.messages || [];
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
await step('“Filter messages like this” on a newsletter starts from its mailing list', async () => {
  await smtp.sendMail({ from: 'Acme News <news@acme.com>', to: 'olivia@acme.com', subject: 'News for November', text: 'Hello readers', headers: { 'List-Id': 'Acme News <news.acme.com>' } });
  await page.getByRole('tab', { name: /Updates/ }).click(); // mailing lists go to Updates
  await refreshUntil(page, row('News for November'));
  await row('News for November').click();
  await page.getByRole('button', { name: 'Filter messages like this' }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  if (await ed.getByLabel('Condition 1 field').inputValue() !== 'list') throw new Error('not the list');
  if (await ed.getByLabel('Condition 1 value').inputValue() !== 'news.acme.com') throw new Error('list id');
  await ed.getByRole('checkbox', { name: 'Move to' }).check();
  await ed.getByLabel('Folder').selectOption('__new__');
  await ed.getByLabel('New folder name').fill('Newsletters');
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved').waitFor();
});
await step('a filter on the message text, made in Filters', async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  const dlg = page.getByRole('dialog', { name: 'Filters' });
  await dlg.getByText('If Mailing list contains “news.acme.com”: move to Newsletters').waitFor();
  await dlg.getByRole('button', { name: /New filter/ }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  await ed.getByLabel('Name').fill('Invoices');
  await ed.getByLabel('Condition 1 field').selectOption('body');
  await ed.getByLabel('Condition 1 value').fill('invoice number');
  await ed.getByRole('checkbox', { name: 'Star it' }).check();
  await page.screenshot({ path: `${SP}/shots/filter-text.png` });
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await dlg.getByText('If Message text contains “invoice number”: star it').waitFor();
  await page.keyboard.press('Escape');
});
await step('the mail server does it: the list into Newsletters (whoever sends), the text starred', async () => {
  await page.waitForTimeout(3000); // the mail server picks up the rules
  await smtp.sendMail({ from: 'Editor <editor@acme.com>', to: 'olivia@acme.com', subject: 'News for December', text: 'More news', headers: { 'List-Id': '"Acme News" <news.acme.com>' } });
  await send(page, { to: 'olivia@acme.com', subject: 'Payment due', text: 'Please quote the invoice number 4411 when paying.' });
  await send(page, { to: 'olivia@acme.com', subject: 'Lunch', text: 'Sandwiches?' });
  const find = (list, s) => list.find((m) => m.subject === s);
  await until(async () => find(await inbox('Newsletters'), 'News for December'), 40000);
  await until(async () => { const l = await inbox(); return find(l, 'Payment due') && find(l, 'Lunch'); }, 40000);
  const l = await inbox();
  if (find(l, 'News for December')) throw new Error('newsletter in the inbox');
  if (!find(l, 'Payment due').flagged) throw new Error(`not starred: ${JSON.stringify(find(l, 'Payment due'))}`);
  if (find(l, 'Lunch').flagged) throw new Error('lunch starred');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
