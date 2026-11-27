import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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

const refreshUntil = async (p, locator, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'METHOD:PUBLISH',
  'BEGIN:VEVENT', 'UID:visit-1@supplier.example', 'DTSTART:20261208T090000Z', 'DTEND:20261208T100000Z', 'SUMMARY:Factory visit', 'LOCATION:Gate B', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n');
const VCF = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Rosa Diaz', 'EMAIL:rosa@supplier.example', 'ORG:Supplier Ltd', 'END:VCARD', ''].join('\r\n');
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true, name: 'test.acme.com' });
await step('an email’s contact card opens as the person, with Add to Contacts', async () => {
  await smtp.sendMail({ from: 'Pat Partner <pat@acme.com>', to: 'olivia@acme.com', subject: 'My details and the visit', text: 'Card and visit attached.',
    attachments: [{ filename: 'Rosa Diaz.vcf', content: VCF, contentType: 'text/vcard' }, { filename: 'Visit.ics', content: ICS, contentType: 'text/calendar' }] });
  const row = page.locator('.mail-list').getByText('My details and the visit', { exact: true });
  await refreshUntil(page, row);
  await row.click();
  await page.locator('a.att', { hasText: 'Rosa Diaz.vcf' }).click();
  const v = page.getByRole('dialog', { name: 'Rosa Diaz.vcf' });
  const list = v.getByRole('region', { name: 'People in these contact cards' });
  await list.getByText('1 person', { exact: true }).waitFor({ timeout: 15000 });
  await list.getByText('rosa@supplier.example · Supplier Ltd').waitFor();
  await list.getByRole('button', { name: 'Add to Contacts' }).click();
  await page.getByText('1 contact added to Contacts').waitFor();
  const mine = (await api(page, 'GET', '/contacts')).body;
  if (!(Array.isArray(mine) ? mine : mine.contacts).some((c) => c.email === 'rosa@supplier.example' && c.company === 'Supplier Ltd')) throw new Error('not in contacts');
});
await step('→ steps to the calendar file attached beside it, with Add to Calendar', async () => {
  await page.getByRole('dialog', { name: 'Rosa Diaz.vcf' }).getByRole('button', { name: 'Next file' }).click();
  const list = page.getByRole('dialog', { name: 'Visit.ics' }).getByRole('region', { name: 'Events in this calendar file' });
  await list.getByText('Factory visit').waitFor({ timeout: 15000 });
  await list.getByText(/Gate B/).waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-ics.png` });
  await list.getByRole('button', { name: 'Add to Calendar' }).click();
  await page.getByText('1 event added to Calendar').waitFor();
  const evs = (await api(page, 'GET', `/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  if (!evs.some((e) => e.title === 'Factory visit' && e.location === 'Gate B')) throw new Error(JSON.stringify(evs.map((e) => e.title)));
  await page.keyboard.press('Escape');
});
await step('a contact card sent in Chat opens the same way', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Tom Ng', 'EMAIL:tom@supplier.example', 'END:VCARD', ''].join('\r\n');
  const f = await page.evaluate(async (t) => (await fetch('/api/files/upload?name=Tom%20Ng.vcf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), card);
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'Tom’s card', files: [f.id] });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Chat' }).first().waitFor();
  await k.goto(`${B}/chat/${dm}`);
  await k.getByRole('link', { name: /Tom Ng\.vcf/ }).click({ timeout: 15000 });
  const list = k.getByRole('dialog', { name: 'Tom Ng.vcf' }).getByRole('region', { name: 'People in these contact cards' });
  await list.getByText('Tom Ng').waitFor({ timeout: 15000 });
  await list.getByRole('button', { name: 'Add to Contacts' }).click();
  await k.getByText('1 contact added to Contacts').waitFor();
}, page);
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
