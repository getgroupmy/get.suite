import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import nodemailer from '../../server/node_modules/nodemailer/dist/cjs/nodemailer.js';
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let kim;
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 20000);
});
const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(10, 0, 0, 0);
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
await step('an invitation from another calendar shows as a card; Yes puts it on the calendar and tells the organiser', async () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:e2e-${Date.now()}@other.example`, 'SEQUENCE:0', `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start.getTime())}`, `DTEND:${stamp(start.getTime() + 36e5)}`, 'SUMMARY:Supplier visit', 'LOCATION:Gate 2', 'ORGANIZER;CN=Kim Park:mailto:kim@acme.com',
    'ATTENDEE;CN=Olivia;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:olivia@acme.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 587, secure: false, auth: { user: 'kim@acme.com', pass: 'password123' }, tls: { rejectUnauthorized: false } });
  for (let i = 0; ; i++) { try { await t.sendMail({ from: 'kim@acme.com', to: 'olivia@acme.com', subject: 'Invitation: Supplier visit', text: 'Please come', icalEvent: { method: 'REQUEST', content: ics } }); break; } catch (e) { if (i > 10) throw e; await new Promise((r) => setTimeout(r, 1000)); } }
  await page.goto(`${B}/mail`);
  const row = page.getByText('Invitation: Supplier visit').first();
  for (let i = 0; i < 30 && !(await row.count()); i++) { await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(700); }
  await row.click();
  const card = page.getByRole('region', { name: 'Invitation' }).or(page.locator('section.mail-invite-card'));
  await card.getByText('Supplier visit').waitFor();
  await card.getByText('Organised by Kim Park').waitFor();
  await card.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByText(/Added to your calendar; Kim Park has been told/).waitFor();
  await until(async () => (await card.getByRole('button', { name: 'Yes', exact: true }).getAttribute('aria-pressed')) === 'true');
  const evs = (await api(page, 'GET', `/events?from=${start.getTime() - 864e5}&to=${start.getTime() + 864e5}`)).body;
  if (!evs.some((e) => e.title === 'Supplier visit' && e.ext_status === 'yes')) throw new Error(JSON.stringify(evs).slice(0, 300));
  kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await until(async () => ((await api(kim, 'GET', '/mail/messages?folder=INBOX')).body?.messages || []).some((m) => m.subject === 'Accepted: Supplier visit'), 20000);
});
await step('See it in Calendar opens the event there', async () => {
  await page.getByRole('button', { name: 'See it in Calendar' }).click();
  await page.getByRole('dialog').getByText(/An invitation from Kim Park, by email · you answered Yes/).waitFor();
});
await step('a guest answering from their calendar app: the card says so and their answer is on the event', async () => {
  const t0 = start.getTime() + 864e5;
  const ev = (await api(page, 'POST', '/events', { title: 'Contract review', start: t0, end: t0 + 36e5, guests: ['ann@clients-test.example'], tz: 'UTC' })).body;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'METHOD:REPLY', 'BEGIN:VEVENT', `UID:${ev.id}@mail.acme.com`, 'SEQUENCE:0', `DTSTAMP:${stamp(Date.now())}`,
    'ATTENDEE;CN=Ann Swerer;PARTSTAT=TENTATIVE:mailto:ann@clients-test.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: 587, secure: false, auth: { user: 'kim@acme.com', pass: 'password123' }, tls: { rejectUnauthorized: false } });
  await t.sendMail({ from: 'kim@acme.com', to: 'olivia@acme.com', subject: 'Tentative: Contract review', text: 'Maybe', icalEvent: { method: 'REPLY', content: ics } });
  await page.goto(`${B}/mail`);
  const row = page.getByText('Tentative: Contract review').first();
  for (let i = 0; i < 30 && !(await row.count()); i++) { await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(700); }
  await row.click();
  await page.getByRole('region', { name: 'Answer to your invitation' }).getByText('Ann Swerer said maybe to “Contract review”').waitFor();
  const saved = (await api(page, 'GET', `/events?from=${t0 - 1}&to=${t0 + 1}`)).body.find((e) => e.id === ev.id);
  if (saved.guests.find((g) => g.email === 'ann@clients-test.example').status !== 'maybe') throw new Error(JSON.stringify(saved.guests));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
