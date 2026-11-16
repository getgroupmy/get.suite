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
  catch (e) { failed++; console.log('FAIL', name, e.message, (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
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
// Every screen opens without a server error (5xx), a failed API call (4xx other than the expected ones)
// or an error in the browser console.
const bad = [];
page.on('response', (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/') && r.status() < 500) return;
  if (r.status() >= 500 || (r.status() >= 400 && ![401, 404].includes(r.status()))) bad.push(`${r.status()} ${r.request().method()} ${u.pathname}${u.search}`);
});
let ids = {};
// What the page's Content-Security-Policy blocks (the harness's console filter ignores those messages).
await page.context().addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
await step('something to open', async () => {
  for (const kind of ['doc', 'sheet', 'slides']) ids[kind] = (await api(page, 'POST', '/files/new', { kind, name: `Crawl ${kind}` })).body.id;
  ids.form = (await api(page, 'POST', '/forms', { title: 'Crawl form' })).body.id;
  ids.folder = (await api(page, 'POST', '/files/folder', { name: 'Crawl folder' })).body.id;
  // With email on: a new account's mailbox is ready a few seconds after it's made (until then Mail says so).
  if ((await api(page, 'GET', '/mail/status')).body.enabled) {
    const end = Date.now() + 30000;
    while ((await api(page, 'GET', '/mail/folders')).status !== 200) { if (Date.now() > end) throw new Error('mailbox never ready'); await page.waitForTimeout(500); }
  }
});
const ADMIN = ['activity', 'announcements', 'apps', 'checkup', 'company', 'dir', 'drives', 'email', 'links', 'mail', 'money', 'phishing', 'reports', 'responses', 'security', 'settings', 'storage', 'system', 'touch', 'users'];
const pages = () => ['/home', '/drive', '/drive/shared', '/drive/sharedbyme', '/drive/recent', '/drive/starred', '/drive/trash', '/drive/drives', '/drive/approvals', '/drive/signatures', '/drive/links', '/drive/activity', `/drive/folder/${ids.folder}`,
  '/mail', '/calendar', '/contacts', '/tasks', '/notes', '/chat', '/meet', '/forms', `/forms/${ids.form}`, '/settings',
  `/docs/${ids.doc}`, `/sheets/${ids.sheet}`, `/slides/${ids.slides}`, `/slides/${ids.slides}/presenter`, ...ADMIN.map((t) => `/admin?tab=${t}`)];
await step('every screen opens cleanly', async () => {
  const found = [];
  for (const path of pages()) {
    const before = bad.length, errs = errors.length;
    await page.goto(`${B}${path}`);
    await page.waitForTimeout(1800);
    const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
    if (bad.length > before || errors.length > errs || csp.length) found.push(`${path}: ${[...bad.slice(before), ...errors.slice(errs), ...csp.map((c) => `CSP blocked: ${c}`)].join(' | ')}`);
  }
  if (found.length) throw new Error(`\n  ${found.join('\n  ')}`);
});
await step('every screen opens cleanly for someone who isn’t an admin too', async () => {
  await api(page, 'POST', '/users', { local: 'mia', domain: 'acme.com', name: 'Mia Member', password: 'password123' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mia = await ctx.newPage();
  const seen = [], errs = [];
  mia.on('pageerror', (e) => errs.push(e.message));
  mia.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errs.push(m.text()));
  mia.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && (r.status() >= 500 || r.status() === 403 || (r.status() >= 400 && ![401, 404].includes(r.status())))) seen.push(`${r.status()} ${r.request().method()} ${u.pathname}`); });
  await mia.goto(B);
  await mia.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'mia@acme.com', password: 'password123' }) }));
  const found = [];
  for (const path of ['/home', '/drive', '/drive/shared', '/drive/drives', '/drive/approvals', '/drive/signatures', '/drive/links', '/drive/activity', '/mail', '/calendar', '/contacts', '/tasks', '/notes', '/chat', '/meet', '/forms', '/settings', '/admin']) {
    const a = seen.length, b = errs.length;
    await mia.goto(`${B}${path}`);
    await mia.waitForTimeout(1800);
    if (seen.length > a || errs.length > b) found.push(`${path}: ${[...seen.slice(a), ...errs.slice(b)].join(' | ')}`);
  }
  if (found.length) throw new Error(`\n  ${found.join('\n  ')}`);
});
await step('the app page has a Content-Security-Policy that stops injected script', async () => {
  const r = await page.request.get(`${B}/drive`);
  const csp = r.headers()['content-security-policy'] || '';
  if (!/script-src 'self'(;|$)/.test(csp) || /unsafe-inline[^;]*;?\s*$/.test(csp.match(/script-src[^;]*/)?.[0] || '')) throw new Error(csp);
  // An injected handler and a javascript: link don't run.
  await page.goto(`${B}/home`);
  const ran = await page.evaluate(async () => {
    window.__ran = 0;
    const d = document.createElement('div');
    d.innerHTML = '<img src="/no-such-picture.png" onerror="window.__ran++"><a id="jsl" href="javascript:window.__ran++">x</a>';
    document.body.appendChild(d);
    document.getElementById('jsl').click();
    await new Promise((ok) => setTimeout(ok, 300));
    d.remove();
    return window.__ran;
  });
  if (ran) throw new Error(`injected script ran ${ran} time(s)`);
});
await step('without email on the server, Mail says so plainly (not “Server error”)', async () => {
  if ((await api(page, 'GET', '/mail/status')).body.enabled) { console.log('SKIP (email is set up in this run)'); return; }
  await page.goto(`${B}/mail`);
  await page.getByText('Email isn’t set up on this server').waitFor();
  if (await page.getByText('Server error').count()) throw new Error('says Server error');
  // And the API says why, too.
  const r = await api(page, 'GET', '/mail/folders');
  if (r.status !== 503 || r.body.error !== 'Email is not set up on this server') throw new Error(JSON.stringify(r));
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors.slice(0, 5)));
await browser.close();
process.exit(failed ? 1 : 0);
