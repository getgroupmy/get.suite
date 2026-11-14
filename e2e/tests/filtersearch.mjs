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
await step('search, then “Create a filter”: the search becomes its conditions; what a filter can\'t use is said', async () => {
  await send(page, { to: 'olivia@acme.com', subject: 'Receipt for order 77', text: 'Thanks for shopping' });
  await send(page, { to: 'olivia@acme.com', subject: 'Team lunch', text: 'Sandwiches' });
  await until(async () => (await box()).length >= 2, 40000);
  await page.reload();
  const search = page.getByPlaceholder('Search Inbox');
  await search.fill('subject:Receipt -lunch is:unread');
  await search.press('Enter');
  await page.locator('.mail-list').getByText('Receipt for order 77', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create a filter' }).click();
  await page.getByText('Left out of the filter: is:unread (filters look at mail as it arrives)').waitFor();
  const ed = page.getByRole('dialog', { name: 'New filter' });
  if (await ed.getByLabel('Condition 1 field').inputValue() !== 'subject' || await ed.getByLabel('Condition 1 value').inputValue() !== 'Receipt') throw new Error('condition 1');
  if (await ed.getByLabel('Condition 2 field').inputValue() !== 'body' || await ed.getByLabel('Condition 2 comparison').inputValue() !== 'not_contains') throw new Error('condition 2');
  await ed.getByRole('checkbox', { name: 'Star it' }).check();
  await ed.getByRole('checkbox', { name: 'Also apply to messages already in the Inbox' }).check();
  await page.screenshot({ path: `${SP}/shots/filter-from-search.png` });
  await ed.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText('Filter saved, and applied to 1 message already in the Inbox').waitFor();
  const l = await box();
  if (!l.find((m) => m.subject === 'Receipt for order 77').flagged || l.find((m) => m.subject === 'Team lunch').flagged) throw new Error('starred');
  const rules = (await api(page, 'GET', '/mail/rules')).body;
  if (rules.length !== 1 || rules[0].name !== 'Receipt, lunch') throw new Error(JSON.stringify(rules));
});
await step('a search a filter can\'t use says why', async () => {
  const search = page.getByPlaceholder('Search Inbox');
  await search.fill('is:starred');
  await search.press('Enter');
  await page.getByRole('button', { name: 'Create a filter' }).click();
  await page.getByText("A filter can't use is:starred: it looks at mail as it arrives").waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
