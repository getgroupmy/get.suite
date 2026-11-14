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
