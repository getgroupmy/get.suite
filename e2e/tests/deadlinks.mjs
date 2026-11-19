// Links inside Workspace lead somewhere: every in-app link on each app's main screen (and Admin's and
// Settings' pages) is opened, and must land on the page it names, without an error. An address the app
// doesn't know quietly goes to Drive, so a broken link would otherwise go unnoticed.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

await step('setup: a company with something in each app', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const kind of ['doc', 'sheet', 'slides']) await api('POST', '/files/new', { kind, name: `Links ${kind}` });
  const list = (await api('POST', '/tasks/lists', { name: 'Links list' })).body;
  await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Links task', due: new Date().toISOString().slice(0, 10) });
  await api('POST', '/notes', { title: 'Links note', body: 'x' });
  await api('POST', '/forms', { title: 'Links form' });
  await api('POST', '/events', { title: 'Links event', start: Date.now() + 3600e3, end: Date.now() + 7200e3 });
});

const START = ['/home', '/drive', '/drive/recent', '/drive/starred', '/drive/shared', '/calendar', '/chat', '/tasks', '/contacts', '/notes', '/forms', '/meet', '/settings',
  ...['company', 'checkup', 'links', 'system', 'reports', 'phishing', 'announcements', 'apps', 'storage', 'activity', 'drives'].map((t) => `/admin?tab=${t}`)];
const first = (p) => p.split(/[/?#]/).filter(Boolean)[0] || '';
await step('every in-app link on these screens lands where it says', async () => {
  const links = new Map(); // href → the screen it was found on
  for (const path of START) {
    await page.goto(`${B}${path}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
    for (const href of await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))) {
      if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/') || /^\/(f|s|b|book|sign|access|oauth|qa|p)\//.test(href)) continue; // pages outside the app (forms to fill in, booking pages, public links) have tests of their own
      if (!links.has(href)) links.set(href, path);
    }
  }
  const broken = [];
  for (const [href, from] of [...links].slice(0, 250)) {
    const before = errors.length;
    await page.goto(`${B}${href}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
    const landed = new URL(page.url()).pathname;
    // Where it says: the same app (an address the app doesn't know lands on Drive instead).
    if (first(landed) !== first(href)) broken.push(`${href} (on ${from}) went to ${landed}`);
    else if (errors.length > before) broken.push(`${href} (on ${from}): ${errors.slice(before).join(' | ')}`);
  }
  console.log(`opened ${Math.min(links.size, 250)} links found on ${START.length} screens: ${[...links.keys()].join(' ')}`);
  if (broken.length) throw new Error(broken.join(' ; '));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
