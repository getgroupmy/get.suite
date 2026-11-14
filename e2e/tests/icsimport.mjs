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
let kim;
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
await step('import a calendar file from another app', async () => {
  const day = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; });
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:a@x', `DTSTART:${day}T100000Z`, `DTEND:${day}T110000Z`, 'SUMMARY:Supplier call', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b@x', `DTSTART;VALUE=DATE:${day}`, 'SUMMARY:Stocktake', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'work.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('2 events imported').waitFor();
  await page.getByText('Supplier call').first().waitFor();
  await page.getByText('Stocktake').first().waitFor();
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'work.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await page.getByText('0 events imported, 2 already here').waitFor();
});
await step('export your calendar as one file', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export (.ics)' }).click()]);
  if (dl.suggestedFilename() !== 'calendar.ics') throw new Error(dl.suggestedFilename());
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if ((text.match(/BEGIN:VEVENT/g) || []).length !== 2 || !text.includes('SUMMARY:Supplier call')) throw new Error(text.slice(0, 300));
});
await step('import a calendar exported as CSV (Outlook / Google layout)', async () => {
  const day = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 2); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; });
  const csv = `Subject,Start Date,Start Time,End Date,End Time,All day event,Description,Location\nPlanning lunch,${day},12:30 PM,${day},1:30 PM,False,Bring notes,Cafe\nTeam day,${day},,${day},,True,,\n`;
  await page.getByLabel('Calendar file to import').first().setInputFiles({ name: 'outlook.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('2 events imported').waitFor();
  await page.getByText('Planning lunch').first().waitFor();
  await page.getByText('Team day').first().waitFor();
  const evs = (await api(page, 'GET', '/events?from=0&to=99999999999999')).body;
  const lunch = (Array.isArray(evs) ? evs : evs.events || []).find((e) => e.title === 'Planning lunch');
  if (lunch && new Date(lunch.start).getHours() !== 12) throw new Error('lunch at ' + new Date(lunch.start));
});
await step('Export as CSV downloads the events as a spreadsheet, times in your zone', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export as CSV' }).click()]);
  const body = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  if (!body.replace(/^\uFEFF/, '').startsWith('Subject,Start Date,Start Time,End Date,End Time,All day event')) throw new Error(body.slice(0, 200));
  if (!/Planning lunch,\d+\/\d+\/\d{4},12:30 PM,/.test(body)) throw new Error(body);
  if (!/Team day,[^,]+,,[^,]+,,True/.test(body)) throw new Error(body);
  if (!dl.suggestedFilename().endsWith('.csv')) throw new Error(dl.suggestedFilename());
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
