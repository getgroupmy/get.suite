import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
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
await step('import contacts from a phone export, see them, and export them again', async () => {
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
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lee Wong\r\nEMAIL:lee@example.com\r\nTEL:+60 12 000 1111\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mei Ling Tan\r\nEMAIL:meiling@example.com\r\nORG:Globex\r\nEND:VCARD\r\n';
  await page.getByLabel('Contacts file to import').setInputFiles({ name: 'contacts.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
  await page.getByText('2 contacts imported').waitFor();
  await page.getByText('Lee Wong').waitFor();
  await page.getByText('Mei Ling Tan').waitFor();
  await page.getByLabel('Contacts file to import').setInputFiles({ name: 'contacts.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
  await page.getByText('0 contacts imported, 2 already here').waitFor();
  await page.getByLabel('Contacts file to import').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByText(/doesn’t look like a contacts file/).waitFor();
  await page.getByRole('button', { name: 'Export' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^CSV/ }).click()]);
  const text = require('node:fs').readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Mei Ling Tan,meiling@example.com,,Globex,')) throw new Error(text);
  await page.screenshot({ path: `${SP}/shots/contacts-import.png` });
});
await step('LinkedIn’s Connections.csv imports, its notes lines skipped', async () => {
  const csv = 'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nNora,Diaz,https://www.linkedin.com/in/noradiaz,nora@example.com,Globex,Head of Sales,03 Nov 2026\n';
  await page.getByLabel('Contacts file to import').setInputFiles({ name: 'Connections.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText('1 contacts imported').or(page.getByText('1 contact imported')).first().waitFor();
  const row = page.getByRole('row').filter({ hasText: 'Nora Diaz' });
  await row.waitFor();
  const t = await row.innerText();
  if (!t.includes('Head of Sales') || !t.includes('Globex') || !t.includes('linkedin.com/in/noradiaz') || !t.includes('nora@example.com')) throw new Error(t);
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
