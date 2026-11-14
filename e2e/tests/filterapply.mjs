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
const box = async (folder = 'INBOX') => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(folder)}`)).body.messages || [];
const find = (list, s) => list.find((m) => m.subject === s);
let label;
await step('mail already in the Inbox', async () => {
  for (const subject of ['Invoice 101', 'Invoice 102', 'Lunch', 'Lunch plans']) await send(page, { to: 'olivia@acme.com', subject, text: 'x' });
  await until(async () => (await box()).filter((m) => /^(Invoice|Lunch)/.test(m.subject)).length === 4, 40000);
  label = (await api(page, 'POST', '/mail/labels', { name: 'Billing', color: '#188038' })).body;
  await page.reload();
});
await step('a new filter, “Also apply to messages already in the Inbox”: they are filed, read and labelled now', async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  const dlg = page.getByRole('dialog', { name: 'Filters' });
  await dlg.getByRole('button', { name: /New filter/ }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  await ed.getByLabel('Name').fill('Invoices');
  await ed.getByLabel('Condition 1 field').selectOption('subject');
  await ed.getByLabel('Condition 1 value').fill('Invoice');
  await ed.getByRole('checkbox', { name: 'Move to' }).check();
  await ed.getByLabel('Folder').selectOption('__new__');
  await ed.getByLabel('New folder name').fill('Billing');
  await ed.getByRole('checkbox', { name: 'Mark as read' }).check();
  await ed.getByRole('checkbox', { name: 'Label it' }).check();
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await page.screenshot({ path: `${SP}/shots/filter-apply.png` });
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved, and applied to 2 messages already in the Inbox').waitFor();
  const billing = await box('Billing');
  for (const s of ['Invoice 101', 'Invoice 102']) {
    const m = find(billing, s);
    if (!m || !m.seen || !m.labels?.includes(label.id)) throw new Error(`${s}: ${JSON.stringify(m)}`);
  }
  const inbox = await box();
  if (find(inbox, 'Invoice 101') || !find(inbox, 'Lunch')) throw new Error('inbox');
});
await step('“is exactly” matches only that subject; nothing matching says so', async () => {
  const dlg = page.getByRole('dialog', { name: 'Filters' });
  await dlg.getByRole('button', { name: /New filter/ }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  await ed.getByLabel('Condition 1 field').selectOption('subject');
  await ed.getByLabel('Condition 1 comparison').selectOption('is');
  await ed.getByLabel('Condition 1 value').fill('lunch');
  await ed.getByRole('checkbox', { name: 'Star it' }).check();
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved, and applied to 1 message already in the Inbox').waitFor();
  const inbox = await box();
  if (!find(inbox, 'Lunch').flagged || find(inbox, 'Lunch plans').flagged) throw new Error('exact');
  await dlg.getByRole('button', { name: /New filter/ }).click();
  await ed.getByLabel('Condition 1 field').selectOption('subject');
  await ed.getByLabel('Condition 1 value').fill('zeppelin');
  await ed.getByRole('checkbox', { name: 'Star it' }).check();
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved. No messages in the Inbox match it').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
