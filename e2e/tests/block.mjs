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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
await step('someone from another company writes; Add to contacts saves them', async () => {
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gina@globex.com', password: 'password123' }) }));
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Shipping quote', text: 'Our quote is attached.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
  await page.locator('.mail-list').getByText('Shipping quote', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Shipping quote', { exact: true }).click();
  const reader = page.locator('.mail-reader');
  await reader.getByRole('button', { name: 'Add to contacts' }).click();
  await page.getByText('Gina Globex added to your contacts').waitFor();
  await reader.getByText('In your contacts').waitFor();
  const list = (await api(page, 'GET', '/contacts')).body;
  if (!list.some((c) => c.name === 'Gina Globex' && c.email === 'gina@globex.com')) throw new Error(JSON.stringify(list));
});
await step('Block sender: confirm, the message goes to Junk, and a filter rule is made', async () => {
  await page.locator('.mail-reader').getByRole('button', { name: 'Block sender' }).click();
  const d = page.getByRole('dialog', { name: 'Block gina@globex.com?' });
  await d.getByRole('button', { name: 'Block' }).click();
  await page.getByText('Blocked gina@globex.com: their mail goes to Junk').waitFor();
  await until(async () => !(await page.locator('.mail-list').getByText('Shipping quote', { exact: true }).count()));
  const rules = (await api(page, 'GET', '/mail/rules')).body;
  if (rules[0]?.name !== 'Blocked: gina@globex.com') throw new Error(JSON.stringify(rules));
  const junk = (await api(page, 'GET', '/mail/folders')).body.find((f) => f.specialUse === '\\Junk');
  const inJunk = (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(junk.path)}`)).body.messages;
  if (!inJunk.some((m) => m.subject === 'Shipping quote')) throw new Error('not in Junk');
});
await step('Filters: Export gives filters.json; Import adds the ones not there yet', async () => {
  await page.locator('.subnav-item', { hasText: 'Filters' }).click();
  const d = page.getByRole('dialog', { name: 'Filters' });
  const [dl] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Export' }).click()]);
  if (dl.suggestedFilename() !== 'filters.json') throw new Error(dl.suggestedFilename());
  const exported = JSON.parse((await import('node:fs')).readFileSync(await dl.path(), 'utf8'));
  if (exported[0]?.name !== 'Blocked: gina@globex.com') throw new Error(JSON.stringify(exported));
  // The same file back: nothing new.
  await d.getByLabel('Import filters').setInputFiles({ name: 'filters.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByText('Those filters are all here already').waitFor();
  // One more in it.
  const more = [...exported, { name: 'Receipts', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }], actions: { markRead: true } }];
  await d.getByLabel('Import filters').setInputFiles({ name: 'filters.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(more)) });
  await page.getByText('Added 1 filter (1 already there)').waitFor();
  await d.getByText('Receipts').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/filters-import.png` });
  await d.getByLabel('Import filters').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  await page.getByText('That isn’t a filters file (filters.json)').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
