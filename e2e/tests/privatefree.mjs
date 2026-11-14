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
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (p, t) => p.locator('.chip', { hasText: t });
let kim, lee;
const monthView = async (p) => { await p.goto(`${B}/calendar`); await p.getByRole('button', { name: 'Month', exact: true }).or(p.getByRole('radio', { name: 'Month', exact: true })).first().click(); };
let cal, t;
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  cal = (await api(page, 'POST', '/events/calendars', { name: 'Team', color: '#0b8043' })).body;
  await api(page, 'PUT', `/events/calendars/${cal.id}/members`, { members: [{ id: kimId }] });
  t = new Date(); t.setHours(9, 0, 0, 0);
  await api(page, 'POST', '/events', { title: 'Salary review: Sam', location: 'Room 3', start: t.getTime(), end: t.getTime() + 3600e3, calendar_id: cal.id, color: '#0b8043' });
  await api(page, 'POST', '/events', { title: 'Read industry news', start: t.getTime() + 2 * 3600e3, end: t.getTime() + 3 * 3600e3, calendar_id: cal.id });
  await monthView(page);
});
await step('Olivia makes one event private and another free, in the event window', async () => {
  await chip(page, 'Salary review: Sam').first().click();
  let d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByLabel('Private').check();
  await page.screenshot({ path: `${SP}/shots/privateevent.png` });
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await chip(page, 'Salary review: Sam').first().getByLabel('(private)').waitFor();
  await chip(page, 'Read industry news').first().click();
  d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByLabel('Show me as').selectOption('free');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => { const evs = (await api(page, 'GET', `/events?from=${t.getTime() - 1}&to=${t.getTime() + 864e5}`)).body; return evs.find((e) => e.title === 'Salary review: Sam')?.private === 1 && evs.find((e) => e.title === 'Read industry news')?.show_as === 'free'; });
});
await step('Kim, who can only look, sees “Busy” in its place; the free one as it is', async () => {
  await monthView(kim);
  await chip(kim, 'Read industry news').first().waitFor();
  await chip(kim, 'Busy').first().waitFor();
  if (await kim.getByText('Salary review').count()) throw new Error('the private title shows');
  const fb = (await api(kim, 'GET', `/freebusy?users=${(await api(page, 'GET', '/auth/me')).body.user.id}&from=${t.getTime() - 1}&to=${t.getTime() + 864e5}`)).body;
  const busy = Object.values(fb)[0].busy;
  if (busy.length !== 1 || busy[0].start !== t.getTime()) throw new Error(JSON.stringify(busy)); // the free hour doesn't count
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
