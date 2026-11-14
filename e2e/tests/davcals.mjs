import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import fs from 'node:fs';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (t) => page.locator('.chip', { hasText: t });
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
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Month', exact: true }).or(page.getByRole('radio', { name: 'Month', exact: true })).first().click();
});
const dav = (method, url, body, headers = {}) => fetch(B + url, { method, headers: { authorization: 'Basic ' + Buffer.from('olivia@acme.com:password123').toString('base64'), depth: '1', ...(body && { 'content-type': 'application/xml' }), ...headers }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
let me, cal;
await step('a calendar made on the web shows on the phone', async () => {
  me = (await api(page, 'GET', '/auth/me')).body.user;
  await page.getByRole('button', { name: 'Add a calendar' }).click();
  const d = page.getByRole('dialog', { name: 'New calendar' });
  await d.getByLabel('Name').fill('Running club');
  await d.getByRole('radio', { name: '#f4511e' }).click();
  await d.getByRole('button', { name: 'Add calendar' }).click();
  await page.getByRole('checkbox', { name: 'Show Running club' }).waitFor();
  cal = (await api(page, 'GET', '/events/calendars')).body[0];
  const home = await dav('PROPFIND', `/dav/calendars/${me.id}/`);
  if (!home.text.includes(`/dav/calendars/${me.id}/${cal.id}/`) || !home.text.includes('Running club') || !home.text.includes('#F4511EFF')) throw new Error(home.text.slice(0, 600));
});
await step('an event added to it on the phone appears on the web in its colour', async () => {
  const at = (h) => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); };
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:RUN-1', `DTSTART:${at(18)}`, `DTEND:${at(19)}`, 'SUMMARY:Evening run', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const put = await dav('PUT', `/dav/calendars/${me.id}/${cal.id}/run-1.ics`, ics, { 'content-type': 'text/calendar' });
  if (put.status !== 201) throw new Error(`${put.status} ${put.text}`);
  await chip('Evening run').first().waitFor(); // live, without reloading
  const style = await chip('Evening run').first().getAttribute('style');
  if (!/244, 81, 30|f4511e/i.test(style)) throw new Error(style);
  await page.getByRole('checkbox', { name: 'Show Running club' }).uncheck();
  await until(async () => (await chip('Evening run').count()) === 0);
  await page.getByRole('checkbox', { name: 'Show Running club' }).check();
  await chip('Evening run').first().waitFor();
});
await step('renaming and recolouring it on the phone shows on the web', async () => {
  const pp = '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:x="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Marathon training</d:displayname><x:calendar-color>#0B8043FF</x:calendar-color></d:prop></d:set></d:propertyupdate>';
  const r = await dav('PROPPATCH', `/dav/calendars/${me.id}/${cal.id}/`, pp);
  if (r.status !== 207) throw new Error(String(r.status));
  await page.getByRole('checkbox', { name: 'Show Marathon training' }).waitFor();
  await until(async () => /11, 128, 67|0b8043/i.test(await chip('Evening run').first().getAttribute('style')));
  await page.screenshot({ path: `${SP}/shots/davcals.png` });
});
await step('the phone settings mention your own calendars', async () => {
  await page.goto(`${B}/settings`);
  await page.getByText('Your own calendars (Calendar → My calendars) show as separate calendars', { exact: false }).first().waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
