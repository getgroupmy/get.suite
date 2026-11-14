import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const max = await mk('max');
await step('the reminder in a hidden tab is a notification with 5 min late / 10 min late; pressing one tells Max', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/drive`);
  await page.context().grantPermissions(['notifications'], { origin: B });
  // Headless Chromium never grants notifications: say it did, and record what would be shown.
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    window.__shown = [];
    ServiceWorkerRegistration.prototype.showNotification = async function (title, opts) { window.__shown.push({ title, actions: (opts.actions || []).map((a) => a.title), data: opts.data }); };
    localStorage.setItem('nw:desktop-notifications', 'on');
    Object.defineProperty(document, 'hidden', { get: () => true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
  });
  await page.goto(`${B}/drive`);
  await until(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), 15000);
  const start = Date.now() + 70e3;
  await api(page, 'POST', '/events', { title: 'Client call', start, end: start + 30 * 6e4, reminders: [1], guests: ['max@acme.com'] });
  const shown = await until(() => page.evaluate(() => window.__shown.find((x) => x.title === 'Client call')), 45000);
  if (shown.actions.join('|') !== '5 min late|10 min late') throw new Error(JSON.stringify(shown));
  const sw = page.context().serviceWorkers()[0];
  const ok = await sw.evaluate((d) => self.notificationAction('late10', d), shown.data);
  if (!ok) throw new Error('the action failed');
  await max.getByText('⏱ Olivia Owner is running 10 minutes late for “Client call”').waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
