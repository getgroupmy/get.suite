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
const y = new Date().getFullYear();
await step('“Holidays in” Germany: its public holidays on my calendar (🎉), the company\'s own winning on the same day', async () => {
  await api(page, 'POST', '/time-off/holidays', { date: `${y}-12-25`, name: 'Company Christmas' });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.getByLabel('Show public holidays in').selectOption('DE');
  // To December.
  for (let i = 0; i < 12 && !(await page.getByRole('heading', { name: new RegExp(`December ${y}`) }).count()); i++) await page.getByRole('button', { name: /^Next/ }).first().click();
  await page.getByText('🎉 2. Weihnachtstag').waitFor();
  await page.getByText('🏳 Company Christmas').waitFor();
  if (await page.getByText('🎉 1. Weihnachtstag').count()) throw new Error('both on the 25th');
  if ((await page.getByText('🎉 2. Weihnachtstag').getAttribute('title')) !== 'Public holiday: 2. Weihnachtstag') throw new Error('title');
  await page.screenshot({ path: `${SP}/shots/my-holidays.png` });
  await axe(page, 'calendar with holidays');
});
await step('kept for me after a reload; (none) takes them away', async () => {
  await page.reload();
  await until(async () => (await page.getByLabel('Show public holidays in').inputValue()) === 'DE').catch(() => { throw new Error('not kept'); });
  for (let i = 0; i < 12 && !(await page.getByRole('heading', { name: new RegExp(`December ${y}`) }).count()); i++) await page.getByRole('button', { name: /^Next/ }).first().click();
  await page.getByText('🎉 2. Weihnachtstag').waitFor();
  await page.getByLabel('Show public holidays in').selectOption('');
  await page.waitForTimeout(800);
  if (await page.getByText(/🎉/).count()) throw new Error('still shown');
});
await step('chosen in Calendar, it is also a read-only calendar on the phone (CalDAV)', async () => {
  await page.getByLabel('Show public holidays in').selectOption('FR');
  await until(async () => (await api(page, 'GET', '/time-off/my-holidays')).body.country === 'FR');
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  const auth = `Basic ${Buffer.from('olivia@acme.com:password123').toString('base64')}`;
  const r = await fetch(`${B}/dav/calendars/${me.id}/`, { method: 'PROPFIND', headers: { authorization: auth, depth: '1', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' });
  const text = await r.text();
  if (r.status !== 207 || !/Holidays in France/.test(text)) throw new Error(text.slice(0, 300));
  const ev = await fetch(`${B}/dav/calendars/${me.id}/holidays/FR-${y}-07-14.ics`, { headers: { authorization: auth } });
  if (!/SUMMARY:Fête nationale/.test(await ev.text())) throw new Error('event');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
