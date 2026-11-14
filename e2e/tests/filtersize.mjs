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
const upload = (name, bytes) => page.evaluate(async ([n, len]) => (await (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x'.repeat(len) })).json()).id, [name, bytes]);
const inbox = async (folder = 'INBOX') => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(folder)}`)).body.messages || [];
let label;
await step('in Filters: “Attachments has some” labels mail, “Size is larger than 60 KB” files it away', async () => {
  label = (await api(page, 'POST', '/mail/labels', { name: 'Has files', color: '#1a73e8' })).body;
  await page.reload();
  await page.getByRole('button', { name: 'Filters' }).click();
  const dlg = page.getByRole('dialog', { name: 'Filters' });
  await dlg.getByRole('button', { name: /New filter/ }).click();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  await ed.getByLabel('Name').fill('Files');
  await ed.getByLabel('Condition 1 field').selectOption('attachment');
  if (await ed.getByLabel('Condition 1 value').count()) throw new Error('no value for attachments');
  await ed.getByLabel('Condition 1 comparison').selectOption('has');
  await ed.getByRole('checkbox', { name: 'Label it' }).check();
  await ed.getByLabel('Label', { exact: true }).selectOption({ label: 'Has files' });
  await ed.getByRole('checkbox', { name: /Don't apply later filters/ }).uncheck();
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved').waitFor();
  await dlg.getByText('If it has attachments: label it “Has files”').waitFor();
  await dlg.getByRole('button', { name: /New filter/ }).click();
  await ed.getByLabel('Name').fill('Big ones');
  await ed.getByLabel('Condition 1 field').selectOption('size');
  await ed.getByLabel('Condition 1 value').fill('60 kb');
  await ed.getByRole('checkbox', { name: 'Move to' }).check();
  await ed.getByLabel('Folder').selectOption('__new__');
  await ed.getByLabel('New folder name').fill('Big');
  await page.screenshot({ path: `${SP}/shots/filter-size.png` });
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await dlg.getByText('If it is larger than 60 KB: move to Big').waitFor();
  await page.keyboard.press('Escape');
});
await step('the mail server does it as mail arrives', async () => {
  await page.waitForTimeout(3000); // the mail server picks up the rules
  const small = await upload('notes.txt', 2000), big = await upload('scan.txt', 100000);
  await send(page, { to: 'olivia@acme.com', subject: 'Small with file', text: 'see file', attachments: [small] });
  await send(page, { to: 'olivia@acme.com', subject: 'Big with file', text: 'see file', attachments: [big] });
  await send(page, { to: 'olivia@acme.com', subject: 'Just words', text: 'hello' });
  const find = (list, s) => list.find((m) => m.subject === s);
  await until(async () => { const l = await inbox(); return find(l, 'Small with file') && find(l, 'Just words'); }, 40000);
  await until(async () => find(await inbox('Big'), 'Big with file'), 40000);
  const l = await inbox();
  if (!find(l, 'Small with file').labels?.includes(label.id)) throw new Error(`small not labelled: ${JSON.stringify(find(l, 'Small with file'))}`);
  if (find(l, 'Just words').labels?.length) throw new Error('plain one labelled');
  if (find(l, 'Big with file')) throw new Error('big stayed in the inbox');
  if (!find(await inbox('Big'), 'Big with file').labels?.includes(label.id)) throw new Error('big not labelled');
  await page.locator('.mail-list').getByText('Small with file', { exact: true }).waitFor().catch(() => {});
});
await step('deleting the label: the filter that only labelled is switched off, and says so', async () => {
  await api(page, 'DELETE', `/mail/labels/${label.id}`);
  const rules = (await api(page, 'GET', '/mail/rules')).body;
  const files = rules.find((r) => r.name === 'Files');
  if (files.enabled || files.actions.label) throw new Error(JSON.stringify(files));
  if (!rules.find((r) => r.name === 'Big ones').enabled) throw new Error('the other one changed');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
