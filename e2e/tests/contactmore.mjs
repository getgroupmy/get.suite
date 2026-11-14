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
await step('a contact with a second email and a second phone, each labelled', async () => {
  await page.getByRole('button', { name: /New contact|Add contact/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New contact' });
  await dlg.getByLabel('Name').fill('Lena Lark');
  await dlg.getByLabel('Email', { exact: true }).fill('lena@work.example');
  await dlg.getByRole('button', { name: '+ Add another email' }).click();
  await dlg.getByLabel('Email 2', { exact: true }).fill('lena@home.example');
  await dlg.getByLabel('Phone', { exact: true }).fill('+60 12 111 2222');
  await dlg.getByRole('button', { name: '+ Add another phone' }).click();
  await dlg.getByLabel('Label for phone 2').selectOption('mobile');
  await dlg.getByLabel('Phone 2', { exact: true }).fill('+60 19 333 4444');
  await dlg.getByRole('button', { name: '+ Add another phone' }).click(); // left empty: not kept
  await page.screenshot({ path: `${SP}/shots/contactmore-dialog.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await row('Lena Lark').waitFor();
  const t = await row('Lena Lark').innerText();
  if (!/lena@home\.example\s*Home/.test(t) || !/\+60 19 333 4444\s*Mobile/.test(t)) throw new Error(t);
  const c = (await api(page, 'GET', '/contacts')).body.find((x) => x.name === 'Lena Lark');
  if (c.more_phones.length !== 1 || c.more_emails[0].type !== 'home') throw new Error(JSON.stringify(c));
  await page.screenshot({ path: `${SP}/shots/contactmore.png` });
});
await step('a bad second address is refused; removing one keeps the rest', async () => {
  await row('Lena Lark').getByRole('button', { name: /Edit/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit contact' });
  await dlg.getByLabel('Email 2', { exact: true }).fill('not-an-address');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.locator('.error, :invalid').first().waitFor();
  await dlg.getByLabel('Email 2', { exact: true }).fill('lena@home.example');
  await dlg.getByRole('button', { name: 'Remove phone 2' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => { const c = (await api(page, 'GET', '/contacts')).body.find((x) => x.name === 'Lena Lark'); return c.more_phones.length === 0 && c.more_emails.length === 1; });
});
await step('both addresses are suggested when writing mail, and the card carries both', async () => {
  const sug = (await api(page, 'GET', '/contacts/suggest?q=lena')).body.map((x) => x.email);
  if (!sug.includes('lena@work.example') || !sug.includes('lena@home.example')) throw new Error(JSON.stringify(sug));
  const vcf = await page.evaluate(async () => (await fetch('/api/contacts/export?format=vcf')).text());
  if (!/EMAIL;TYPE=INTERNET,HOME:lena@home\.example/.test(vcf)) throw new Error(vcf);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
