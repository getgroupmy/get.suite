import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who, init) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
// Stand-in for the browser's notification system, plus a switch to pretend the tab is in the background.
const fakeNotifications = () => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__background });
  window.__notes = [];
  window.Notification = class {
    // Like a real browser, a granted permission survives page loads.
    static get permission() { return localStorage.getItem('fake-permission') || 'default'; }
    static requestPermission() { localStorage.setItem('fake-permission', 'granted'); return Promise.resolve('granted'); }
    constructor(title, opts) { window.__notes.push({ title, ...opts }); }
    close() {}
  };
};
const page = await mk('olivia', fakeNotifications);
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const badge = (p) => p.locator('.appnav .nav-badge');

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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Desktop alerts/ }).click();
  await page.locator('.toast', { hasText: 'Desktop notifications on' }).waitFor();
});

const gina = await mk('gina');
await step('toast-badge-title-while-in-drive', async () => {
  await page.goto(B + '/drive'); // somewhere else in Workspace
  await page.waitForTimeout(3000); // live connection + mail watcher ready
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.locator('.appnav').waitFor();
  const t0 = Date.now();
  const r = await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Container arrived', text: 'It is at the port.' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await page.locator('.toast', { hasText: 'New mail from Gina Globex: Container arrived' }).waitFor({ timeout: 10000 });
  console.log(`  notified after ${Date.now() - t0} ms`);
  await badge(page).filter({ hasText: '1' }).waitFor();
  if (!(await page.title()).startsWith('(1) ')) throw new Error('title: ' + await page.title());
  await page.screenshot({ path: `${SP}/shots/notify-toast.png` });
});

await step('desktop-alert-when-tab-in-background', async () => {
  await page.evaluate(() => { window.__background = true; });
  await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Customs paperwork', text: 'Attached soon.' });
  await page.waitForFunction(() => window.__notes.some((n) => n.body === 'Customs paperwork'), null, { timeout: 10000 });
  const note = await page.evaluate(() => window.__notes.find((n) => n.body === 'Customs paperwork'));
  if (note.title !== 'Gina Globex') throw new Error(JSON.stringify(note));
  await page.evaluate(() => { window.__background = false; });
  await badge(page).filter({ hasText: '2' }).waitFor();
});

await step('inbox-updates-by-itself-and-badge-clears', async () => {
  await page.getByRole('link', { name: /Mail/ }).click();
  await page.locator('.msg-list li', { hasText: 'Customs paperwork' }).waitFor();
  await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Third one, live', text: 'x' });
  await page.locator('.msg-list li', { hasText: 'Third one, live' }).waitFor({ timeout: 10000 }); // no Refresh click
  await badge(page).filter({ hasText: '3' }).waitFor();
  for (const subj of ['Third one, live', 'Customs paperwork', 'Container arrived']) {
    await page.locator('.msg-list li', { hasText: subj }).locator('.msg-row').click();
    await page.locator('.reader-subject', { hasText: subj }).waitFor();
  }
  await page.waitForFunction(() => !document.querySelector('.appnav .nav-badge'), null, { timeout: 10000 });
  if ((await page.title()).startsWith('(')) throw new Error('title still shows unread: ' + await page.title());
});

await step('forward-as-attachment', async () => {
  await page.locator('.msg-list li', { hasText: 'Container arrived' }).locator('.msg-row').click();
  await page.getByRole('button', { name: 'Forward as attachment' }).click();
  await page.getByRole('list', { name: 'Forwarded message' }).getByText('Container arrived.eml').waitFor();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('See the original below.');
  await page.screenshot({ path: `${SP}/shots/forward-eml.png` });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  await gina.getByRole('link', { name: /Mail/ }).click();
  await gina.locator('.msg-list li', { hasText: 'Fwd: Container arrived' }).locator('.msg-row').click({ timeout: 15000 });
  await gina.locator('a.att', { hasText: 'Container arrived.eml' }).waitFor();
}, page);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
