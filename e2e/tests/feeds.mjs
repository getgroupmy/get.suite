import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import http from 'node:http';
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
const now = new Date();
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
const next = new Date(day.getTime() + 864e5);
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Office holidays', 'BEGIN:VEVENT', 'UID:o1@test', `DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(next)}`, 'SUMMARY:Founders Day', 'DESCRIPTION:The office is closed.', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(ics); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${srv.address().port}/office.ics`;
await step('subscribe to a calendar by its address', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Subscribe to a calendar' }).click();
  const d = page.getByRole('dialog', { name: 'Subscribe to a calendar' });
  await d.getByLabel('Calendar address').fill(feed);
  await d.getByRole('button', { name: 'Subscribe' }).click();
  await page.getByText('Added “Office holidays” (1 event)').waitFor();
  await page.getByRole('list', { name: 'Subscribed calendars' }).getByText('Office holidays').waitFor();
});
await step('its events show, read-only', async () => {
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Founders Day', { exact: true }).first().click();
  const d = page.getByRole('dialog', { name: 'Founders Day' });
  await d.getByText('The office is closed.').waitFor();
  await d.getByText(/From Office holidays, a calendar you subscribe to/).waitFor();
  if (await d.getByRole('button', { name: 'Save' }).count()) throw new Error('editable');
  await page.keyboard.press('Escape');
});
await step('the tick box beside a subscribed calendar hides its events, and shows them again', async () => {
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Founders Day', { exact: true }).first().waitFor();
  const box = page.getByRole('checkbox', { name: 'Show Office holidays' });
  if (!(await box.isChecked())) throw new Error('off at first');
  await box.uncheck();
  await until(async () => !(await page.getByText('Founders Day', { exact: true }).count()));
  await page.reload();
  await page.getByRole('checkbox', { name: 'Show Office holidays' }).waitFor();
  if (await page.getByRole('checkbox', { name: 'Show Office holidays' }).isChecked()) throw new Error('on again after reload');
  if (await page.getByText('Founders Day', { exact: true }).count()) throw new Error('shown after reload');
  if (!(await page.getByRole('list', { name: 'Subscribed calendars' }).getByText('Office holidays').count())) throw new Error('unsubscribed');
  await page.screenshot({ path: `${SP}/shots/feeds-hidden.png` });
  await page.getByRole('checkbox', { name: 'Show Office holidays' }).check();
  await page.getByText('Founders Day', { exact: true }).first().waitFor();
});
await step('subscribed calendars in your own order: Move up / Move down in a calendar’s options', async () => {
  for (const name of ['Team rota', 'School terms']) if ((await api(page, 'POST', '/events/feeds', { url: feed, name })).status !== 201) throw new Error('add ' + name);
  await page.reload();
  const list = page.getByRole('list', { name: 'Subscribed calendars' });
  const names = () => list.locator('li .grow').allTextContents();
  await until(async () => (await names()).join('|') === 'Office holidays|Team rota|School terms');
  await page.getByRole('button', { name: 'Options for School terms' }).click();
  if (await page.getByRole('menuitem', { name: 'Move down' }).count()) throw new Error('down from the last');
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await until(async () => (await names()).join('|') === 'Office holidays|School terms|Team rota');
  await page.getByRole('button', { name: 'Options for Office holidays' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await until(async () => (await names()).join('|') === 'School terms|Office holidays|Team rota');
  await page.reload();
  await until(async () => (await names()).join('|') === 'School terms|Office holidays|Team rota');
  await page.screenshot({ path: `${SP}/shots/feeds-order.png` });
  for (const f of (await api(page, 'GET', '/events/feeds')).body.filter((x) => x.name !== 'Office holidays')) await api(page, 'DELETE', `/events/feeds/${f.id}`);
  await page.reload();
  await until(async () => (await names()).join('|') === 'Office holidays');
});
await step('Name and colour… renames a subscribed calendar and gives its events a colour', async () => {
  await page.getByRole('button', { name: 'Options for Office holidays' }).click();
  await page.getByRole('menuitem', { name: 'Name and colour…' }).click();
  const d = page.getByRole('dialog', { name: 'Calendar' });
  if (await d.getByText(/events you gave a colour of their own/).count()) throw new Error('note for own calendars shown');
  await d.getByLabel('Name').fill('Closed days');
  await d.getByRole('radio', { name: '#0b8043' }).click();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByRole('list', { name: 'Subscribed calendars' }).getByText('Closed days').waitFor();
  const f = (await api(page, 'GET', '/events/feeds')).body.find((x) => x.name === 'Closed days');
  if (f?.color !== '#0b8043') throw new Error(JSON.stringify(f));
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Founders Day', { exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Founders Day' }).getByText(/From Closed days, a calendar you subscribe to/).waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SP}/shots/feeds-rename.png` });
  await api(page, 'PATCH', `/events/feeds/${f.id}`, { name: 'Office holidays' });
  await page.reload();
  await page.getByRole('list', { name: 'Subscribed calendars' }).getByText('Office holidays').waitFor();
});
await step('unsubscribe removes them', async () => {
  await page.getByRole('button', { name: 'Options for Office holidays' }).click();
  await page.getByRole('menuitem', { name: 'Unsubscribe' }).click();
  await page.getByText('Removed Office holidays').waitFor();
  await until(async () => !(await page.getByText('Founders Day', { exact: true }).count()));
});
srv.close();
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
