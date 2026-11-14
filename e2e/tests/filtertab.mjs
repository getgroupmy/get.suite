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
const tab = async (t) => (await api(page, 'GET', `/mail/messages?folder=INBOX&tab=${t}`)).body.messages || [];
const has = (list, s) => list.some((m) => m.subject === s);
const newFilter = async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('dialog', { name: 'Filters' }).getByRole('button', { name: /New filter/ }).click();
  return page.getByRole('dialog', { name: 'New filter' });
};
await step('the team list in Updates; a filter “Show in Primary”, also for what\'s there, brings it over', async () => {
  await smtp.sendMail({ from: 'Team <team@acme.com>', to: 'olivia@acme.com', subject: 'Team plans', text: 'Offsite next month', headers: { 'List-Id': 'Team <team.acme.com>' } });
  await until(async () => has(await tab('updates'), 'Team plans'), 40000);
  await page.reload();
  const ed = await newFilter();
  await ed.getByLabel('Condition 1 field').selectOption('list');
  await ed.getByLabel('Condition 1 value').fill('team.acme.com');
  await ed.getByRole('checkbox', { name: 'Show in the Inbox tab' }).check();
  await ed.getByLabel('Inbox tab', { exact: true }).selectOption('primary');
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await page.screenshot({ path: `${SP}/shots/filter-tab.png` });
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved, and applied to 1 message already in the Inbox').waitFor();
  await page.getByRole('dialog', { name: 'Filters' }).getByText('If Mailing list contains “team.acme.com”: show in Primary').waitFor();
  if (!has(await tab('primary'), 'Team plans') || has(await tab('updates'), 'Team plans')) throw new Error('not moved to Primary');
  await page.getByRole('dialog', { name: 'Filters' }).getByRole('button', { name: 'Close' }).click();
});
await step('and as mail arrives: “Show in Updates” for build alerts from a colleague', async () => {
  const ed = await newFilter();
  await ed.getByLabel('Condition 1 field').selectOption('subject');
  await ed.getByLabel('Condition 1 value').fill('Build failed');
  await ed.getByRole('checkbox', { name: 'Show in the Inbox tab' }).check();
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved').waitFor();
  await page.getByRole('dialog', { name: 'Filters' }).getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(3000); // the mail server picks up the rules
  await send(page, { to: 'olivia@acme.com', subject: 'Build failed: main', text: 'see logs' });
  await send(page, { to: 'olivia@acme.com', subject: 'Coffee?', text: 'at 3' });
  await smtp.sendMail({ from: 'Team <team@acme.com>', to: 'olivia@acme.com', subject: 'Team plans 2', text: 'More', headers: { 'List-Id': 'Team <team.acme.com>' } });
  await until(async () => has(await tab('updates'), 'Build failed: main') && has(await tab('primary'), 'Coffee?') && has(await tab('primary'), 'Team plans 2'), 40000);
  await page.getByRole('tab', { name: /Updates/ }).click();
  await refreshUntil(page, page.locator('.mail-list').getByText('Build failed: main', { exact: true }));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
