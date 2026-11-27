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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
  'BEGIN:VEVENT', 'UID:kick-1@test', 'DTSTART:20261203T100000Z', 'DTEND:20261203T113000Z', 'SUMMARY:Supplier kick-off', 'LOCATION:Room 4', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:fair-2@test', 'DTSTART;VALUE=DATE:20261210', 'DTEND;VALUE=DATE:20261211', 'SUMMARY:Trade fair', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n');
const VCF = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Rosa Diaz', 'EMAIL:rosa@supplier.example', 'TEL:+44 20 7946 0000', 'ORG:Supplier Ltd', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Tom Ng', 'EMAIL:tom@supplier.example', 'END:VCARD', ''].join('\r\n');
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
let icsFile;
await step('a calendar file in Drive opens as its list of events, and Add to Calendar puts them in your calendar (once)', async () => {
  icsFile = await upload('Supplier dates.ics', ICS);
  await page.goto(`${B}/drive`);
  let downloaded = false; page.on('download', () => { downloaded = true; });
  await page.getByText('Supplier dates.ics').dblclick();
  const list = page.getByRole('region', { name: 'Events in this calendar file' });
  await list.getByText('2 events', { exact: true }).waitFor({ timeout: 15000 });
  await list.getByText('Supplier kick-off').waitFor();
  await list.getByText(/Room 4/).waitFor();
  await list.getByText(/repeats/).waitFor();
  await page.screenshot({ path: `${SP}/shots/drive-ics.png` });
  await list.getByRole('button', { name: 'Add to Calendar' }).click();
  await page.getByText('2 events added to Calendar').waitFor();
  const evs = (await api(page, 'GET', `/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  if (!evs.some((e) => e.title === 'Supplier kick-off' && e.location === 'Room 4') || !evs.some((e) => e.title === 'Trade fair')) throw new Error(JSON.stringify(evs.map((e) => e.title)));
  await list.getByRole('button', { name: 'Add to Calendar' }).click();
  await page.getByText('0 events added to Calendar, 2 already there').waitFor();
  if (downloaded) throw new Error('opening it started a download');
  await page.keyboard.press('Escape');
});
await step('contact cards (.vcf) in Drive open as their people, and Add to Contacts adds them', async () => {
  await upload('Suppliers.vcf', VCF);
  await page.goto(`${B}/drive`);
  await page.getByText('Suppliers.vcf').dblclick();
  const list = page.getByRole('region', { name: 'People in these contact cards' });
  await list.getByText('2 people', { exact: true }).waitFor({ timeout: 15000 });
  await list.getByText('Rosa Diaz').waitFor();
  await list.getByText('rosa@supplier.example · +44 20 7946 0000 · Supplier Ltd').waitFor();
  await list.getByRole('button', { name: 'Add to Contacts' }).click();
  await page.getByText('2 contacts added to Contacts').waitFor();
  await page.getByRole('button', { name: 'Show' }).click();
  await page.waitForURL(/\/contacts/);
  await page.getByText('Rosa Diaz').first().waitFor({ timeout: 15000 });
});
await step('someone who may only view (downloading off) sees the events but no Add button', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'PUT', `/files/${icsFile.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  await api(page, 'PATCH', `/files/${icsFile.id}`, { no_download: true });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Drive' }).waitFor();
  await k.goto(`${B}/drive?preview=${icsFile.id}`);
  const list = k.getByRole('region', { name: 'Events in this calendar file' });
  await list.getByText('Supplier kick-off').waitFor({ timeout: 15000 });
  await list.getByText(/turned off downloading/).waitFor();
  if (await list.getByRole('button', { name: 'Add to Calendar' }).count()) throw new Error('Add shown to a view-only person');
}, page);
await step('a .tsv in Drive no longer starts a download when looked at', async () => {
  await upload('Prices.tsv', 'Item\tPrice\nChair\t40\n');
  await page.goto(`${B}/drive`);
  let downloaded = false; const on = () => { downloaded = true; }; page.on('download', on);
  await page.getByText('Prices.tsv').dblclick();
  await page.getByRole('dialog', { name: 'Prices.tsv' }).getByRole('button', { name: /Open as spreadsheet/ }).waitFor();
  await page.waitForTimeout(1500);
  page.off('download', on);
  if (downloaded) throw new Error('a download started');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
