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
const row = (name) => page.locator('table.files tbody tr', { hasText: name });
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
  await page.goto(`${B}/contacts`);
});
await step('an Outlook CSV with several addresses and numbers comes in whole', async () => {
  const csv = 'First Name,Last Name,E-mail Address,E-mail 2 Address,Mobile Phone,Business Phone,Home Phone\r\nLena,Lark,lena@work.example,lena@home.example,+44 7700 900111,+44 20 7946 0000,+44 113 496 0000\r\n';
  await page.getByLabel('Contacts file to import').setInputFiles({ name: 'outlook.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await row('Lena Lark').waitFor();
  const t = await row('Lena Lark').innerText();
  for (const want of ['lena@work.example', 'lena@home.example', '+44 7700 900111', '+44 20 7946 0000', '+44 113 496 0000']) if (!t.includes(want)) throw new Error(`${want} missing: ${t}`);
  if (!/\+44 20 7946 0000\s*Work/.test(t) || !/\+44 113 496 0000\s*Home/.test(t)) throw new Error('labels: ' + t);
});
await step('Export as CSV writes them as Gmail’s E-mail 2 and Phone 2 columns', async () => {
  const csv = await page.evaluate(async () => (await fetch('/api/contacts/export?format=csv')).text());
  const [head, line] = csv.replace(/^﻿/, '').split('\r\n');
  if (!/E-mail 2 - Value,Phone 2 - Type,Phone 2 - Value,Phone 3 - Type,Phone 3 - Value$/.test(head)) throw new Error(head);
  if (!line.includes('Work,+44 20 7946 0000,Home,+44 113 496 0000')) throw new Error(line);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
