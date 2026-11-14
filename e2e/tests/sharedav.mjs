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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  const cal = (await api(page, 'POST', '/events/calendars', { name: 'Team holidays', color: '#0b8043' })).body;
  const t = new Date(); t.setHours(9, 0, 0, 0);
  await api(page, 'POST', '/events', { title: 'Olivia away', start: t.getTime(), end: t.getTime() + 3600e3, calendar_id: cal.id, color: '#0b8043' });
  await api(page, 'POST', '/events', { title: 'Private dentist', start: t.getTime(), end: t.getTime() + 3600e3 });
  await monthView(page);
});
const dav = (who, method, url, body, headers = {}) => fetch(B + url, { method, headers: { authorization: 'Basic ' + Buffer.from(`${who}@acme.com:password123`).toString('base64'), depth: '1', ...(body && { 'content-type': 'application/xml' }), ...headers }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
let cal, kimId, leeId;
await step('Olivia shares Team holidays: Kim to see, Lee to change', async () => {
  cal = (await api(page, 'GET', '/events/calendars')).body[0];
  kimId = (await api(kim, 'GET', '/auth/me')).body.user.id;
  leeId = (await api(lee, 'GET', '/auth/me')).body.user.id;
  await page.getByRole('button', { name: 'Options for Team holidays' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const d = page.getByRole('dialog', { name: 'Share “Team holidays”' });
  await d.getByLabel('Share with a colleague').selectOption({ label: 'Kim Park' });
  await d.getByLabel('What Kim Park can do').waitFor();
  await d.getByLabel('Share with a colleague').selectOption({ label: 'Lee Chan' });
  await d.getByLabel('What Lee Chan can do').selectOption('edit');
  await until(async () => (await api(page, 'GET', '/events/calendars')).body[0].members.find((m) => m.name === 'Lee Chan')?.can_edit);
  await d.getByRole('button', { name: 'Done' }).click();
});
await step('on Kim\'s phone it is read-only, with Olivia\'s events', async () => {
  const home = await dav('kim', 'PROPFIND', `/dav/calendars/${kimId}/`);
  if (!home.text.includes(`/dav/calendars/${kimId}/${cal.id}/`) || !home.text.includes('Team holidays (Olivia Owner)')) throw new Error(home.text.slice(0, 500));
  const list = await dav('kim', 'REPORT', `/dav/calendars/${kimId}/${cal.id}/`, '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop></c:calendar-query>');
  if (!list.text.includes('Olivia away') || list.text.includes('Private dentist')) throw new Error(list.text.slice(0, 500));
  const put = await dav('kim', 'PUT', `/dav/calendars/${kimId}/${cal.id}/k.ics`, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:K-1\r\nDTSTART:20261201T090000Z\r\nDTEND:20261201T100000Z\r\nSUMMARY:Nope\r\nEND:VEVENT\r\nEND:VCALENDAR', { 'content-type': 'text/calendar' });
  if (put.status !== 403) throw new Error(String(put.status));
});
await step('Lee adds an event from the phone: Olivia sees it live, in the calendar\'s colour, and is told', async () => {
  const at = (h) => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); };
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:LEE-1', `DTSTART:${at(14)}`, `DTEND:${at(15)}`, 'SUMMARY:Lee off (phone)', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const put = await dav('lee', 'PUT', `/dav/calendars/${leeId}/${cal.id}/lee-1.ics`, ics, { 'content-type': 'text/calendar' });
  if (put.status !== 201) throw new Error(`${put.status} ${put.text}`);
  await chip(page, 'Lee off (phone)').first().waitFor();
  const style = await chip(page, 'Lee off (phone)').first().getAttribute('style');
  if (!/11, 128, 67|0b8043/i.test(style)) throw new Error(style);
  await page.getByRole('button', { name: /Notifications/ }).first().click();
  await page.getByText('Lee Chan added “Lee off (phone)” in Team holidays').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/sharedav.png` });
  await page.keyboard.press('Escape');
  // Kim (on the web) sees it too.
  await monthView(kim);
  await chip(kim, 'Lee off (phone)').first().waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
