import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|429|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const tabBtn = (name) => page.getByRole('tab', { name }).or(page.getByRole('button', { name, exact: true })).first();
const list = () => page.getByRole('list', { name: 'Checkup' });
await step('Admin → Security checkup: what needs attention, worst first', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/admin`);
  await tabBtn('Security checkup').click();
  // 2 without email; with email on, acme.com's missing SPF/DKIM/DMARC (not set up here) makes 3.
  await page.getByRole('status').getByText(/^[23] things need attention$/).waitFor();
  const mailOn = (await api(page, 'GET', '/mail/status').catch(() => null))?.body?.enabled;
  if (mailOn && !(await list().getByText(/acme\.com: .*(SPF|DKIM|DMARC).* set up right/).count())) throw new Error('no DNS item with email on');
  const items = await list().locator('li').allInnerTexts();
  if (!/^⚠\s*1 admin signs in with just a password/.test(items[0])) throw new Error(items[0]);
  if (!items.some((x) => /Mail from outside the company isn’t marked/.test(x))) throw new Error(items.join(' | '));
  await page.screenshot({ path: `${SP}/shots/checkup.png` });
  await axe(page, 'checkup');
});
await step('Go to Company settings from an item, fix it, and the checkup says so', async () => {
  await list().locator('li', { hasText: 'Mail from outside the company isn’t marked' }).getByRole('button', { name: 'Go to Company settings' }).click();
  await page.getByLabel('Mark email from outside the company').check();
  await page.getByText('Mail from outside the company now shows a warning').waitFor();
  await tabBtn('Security checkup').click();
  await list().waitFor();
  if (await list().getByText('Mail from outside the company isn’t marked').count()) throw new Error('still listed');
});
await step('the weekly notice’s link opens the checkup', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  await list().waitFor();
  if ((await page.getByRole('tab', { name: 'Security checkup' }).getAttribute('aria-selected')) !== 'true') throw new Error('not the checkup tab');
});
await step('accounts unused for 90 days: suspended from the checkup', async () => {
  const oldId = (await api(page, 'POST', '/users', { local: 'old', domain: 'acme.com', name: 'Old Timer', password: 'password123' })).body.id;
  // Nobody can be 90 days old in a test: set it in the database, as the server keeps it.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  db.prepare('UPDATE users SET created_at = ?, last_active = ? WHERE id = ?').run(Date.now() - 200 * 864e5, Date.now() - 120 * 864e5, oldId);
  db.close();
  await page.goto(`${B}/admin?tab=checkup`);
  const item = list().locator('li', { hasText: 'not used for 90 days' });
  await item.getByText(/Old Timer/).waitFor();
  await item.getByRole('button', { name: 'Suspend this account' }).click();
  const d = page.getByRole('dialog', { name: 'Suspend Old Timer?' });
  await axe(page, 'suspend');
  await d.getByRole('button', { name: 'Suspend' }).click();
  await page.getByText('Suspended 1').waitFor();
  await until(async () => !(await list().getByText('not used for 90 days').count()));
  const u = (await api(page, 'GET', '/users')).body.find((x) => x.id === oldId);
  if (!u.disabled) throw new Error('not suspended');
});
await step('fix right there: sign people out after 8 hours away; requiring two steps says why it can’t yet', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  await list().locator('li', { hasText: 'People stay signed in while away' }).getByRole('button', { name: 'Sign out after 8 hours away' }).click();
  await page.getByText('Done: sign out after 8 hours away').waitFor();
  await until(async () => !(await list().getByText('People stay signed in while away').count()));
  await list().getByRole('button', { name: 'Require two-step verification' }).click();
  await page.getByText(/Turn on two-step verification for your own account first/).waitFor();
});
await step('no recovery email: Remind them sends each a notice (and not twice in a day)', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  const item = list().locator('li', { hasText: 'no recovery email' });
  await item.getByRole('button', { name: /^Remind them/ }).click();
  await page.getByText(/^Reminded \d+ (person|people) to add a recovery email$/).waitFor();
  await item.getByRole('button', { name: /^Remind them/ }).click();
  await page.getByText('They were reminded less than a day ago').waitFor();
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(B);
  await kim.getByRole('button', { name: /^Notifications/ }).first().click();
  await kim.getByText('Add a recovery email to your account').first().waitFor();
});
await step('people with just a password: Remind them asks each to add a second step', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  await list().locator('li', { hasText: 'sign in with just a password' }).filter({ hasNotText: 'admin' }).getByRole('button', { name: /^Remind them/ }).click();
  await page.getByText(/^Reminded \d+ (person|people) to add a second step$/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
