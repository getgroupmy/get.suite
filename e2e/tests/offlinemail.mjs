import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
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
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheet, kim;
const ctx = page.context();
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
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Fox']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  // The mail server picks up new accounts within a few seconds.
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 30000);
  await until(async () => (await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'warm-up', text: 'x' })).status === 200, 30000);
});
await step('mail read while connected can be read again offline: the inbox, an opened message, the folders', async () => {
  await until(async () => (await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Ferry times', text: 'The 8:15 ferry leaves from pier 3.' })).status === 200, 30000);
  await page.goto(`${B}/mail`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // the worker now runs the page: its files are kept for offline
  const row = page.locator('.mail-list').getByText('Ferry times').first();
  for (let i = 0; i < 20 && !(await row.count()); i++) { await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(700); }
  await row.click();
  await page.getByText('The 8:15 ferry leaves from pier 3.').waitFor();
  await page.waitForTimeout(1000);
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.mail-list').getByText('Ferry times').first().waitFor({ timeout: 20000 });
  await page.getByText(/Showing what was last saved on this device/).waitFor();
  await page.locator('.mail-list').getByText('Ferry times').first().click();
  await page.getByText('The 8:15 ferry leaves from pier 3.').waitFor({ timeout: 20000 });
  await page.getByRole('link', { name: /Sent/ }).or(page.getByRole('button', { name: /Sent/ })).first().waitFor();
  await page.screenshot({ path: `${SP}/shots/offline-mail.png` });
  await ctx.setOffline(false);
  await page.getByText(/Showing what was last saved/).waitFor({ state: 'detached', timeout: 20000 });
});
await step('an email sent offline waits on the device, then goes by itself when the connection is back', async () => {
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.mail-list').getByText('Ferry times').first().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill('Written on the ferry');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('No signal out here.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/You’re offline: the email is in Waiting to send/).waitFor({ timeout: 20000 });
  const out = page.getByRole('button', { name: /Waiting to send/ });
  await out.getByText('1').waitFor();
  await out.click();
  await page.getByRole('list', { name: 'Emails waiting to send' }).getByText('Written on the ferry').waitFor();
  await page.screenshot({ path: `${SP}/shots/outbox.png` });
  await page.getByRole('button', { name: 'Done' }).click();
  await ctx.setOffline(false);
  await page.getByText('Sent 1 email written while offline').waitFor({ timeout: 30000 });
  await out.waitFor({ state: 'detached' });
  await until(async () => (await api(page, 'GET', '/mail/messages?folder=INBOX')).body?.messages?.some((m) => m.subject === 'Written on the ferry'), 30000);
});
await step('mail read, archived offline: shown so here (even after reloading) and made on the server when back', async () => {
  for (const subject of ['Harbour notice', 'Old newsletter']) await until(async () => (await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200, 30000);
  const list = page.locator('.mail-list');
  for (let i = 0; i < 20 && !((await list.getByText('Harbour notice').count()) && (await list.getByText('Old newsletter').count())); i++) { await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(700); }
  await page.waitForTimeout(1000);
  await ctx.setOffline(true);
  await page.getByLabel('Select Harbour notice').check();
  await page.getByRole('button', { name: 'Mark read' }).click();
  await page.getByText('Done on this device: made when the connection is back').waitFor({ timeout: 15000 });
  await page.getByLabel('Select Old newsletter').check();
  await page.locator('button.btn.small', { hasText: /^Archive$/ }).click(); // the bar over the selected messages
  await page.getByText('Archived on this device: made when the connection is back').waitFor({ timeout: 15000 });
  await list.getByText('Old newsletter').waitFor({ state: 'detached' });
  await page.reload();
  await list.getByText('Harbour notice').first().waitFor({ timeout: 20000 });
  if (await list.getByText('Old newsletter').count()) throw new Error('archived message back after reloading');
  await ctx.setOffline(false);
  await page.getByText('Sent 2 changes made offline').waitFor({ timeout: 30000 });
  const inbox = (await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages;
  if (inbox.some((m) => m.subject === 'Old newsletter')) throw new Error('still in the inbox');
  if (!inbox.find((m) => m.subject === 'Harbour notice')?.seen) throw new Error('not read on the server');
  const folders = (await api(page, 'GET', '/mail/folders')).body;
  const archive = (Array.isArray(folders) ? folders : folders.folders).find((f) => f.specialUse === '\\Archive');
  if (!(await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(archive.path)}`)).body.messages.some((m) => m.subject === 'Old newsletter')) throw new Error('not in the archive');
});
await step('mail labelled offline shows the label here (even after reloading) and on the server when back', async () => {
  const label = (await api(page, 'POST', '/mail/labels', { name: 'Travel', color: '#188038' })).body;
  await page.reload(); // the labels are kept for offline too
  const list = page.locator('.mail-list');
  await list.getByText('Harbour notice').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.context().setOffline(true);
  await page.getByLabel('Select Harbour notice').check();
  await page.locator('button.btn.small', { hasText: /^Label$/ }).click();
  await page.getByRole('menuitem', { name: 'Travel' }).click();
  await page.getByText('Labelled Travel on this device: made when the connection is back').waitFor({ timeout: 15000 });
  const row = page.locator('.mail-list li, .mail-list [role="row"], .mail-list a').filter({ hasText: 'Harbour notice' }).first();
  await row.getByText('Travel').waitFor();
  await page.reload();
  await row.getByText('Travel').waitFor({ timeout: 20000 }); // still labelled after reloading offline
  await page.context().setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => (await api(page, 'GET', '/mail/messages?folder=INBOX')).body.messages.find((m) => m.subject === 'Harbour notice')?.labels?.includes(label.id), 10000);
});
const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|WebSocket/.test(e));
if (real.length) { failed++; console.log('FAIL page errors', real.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
