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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
await step('Share → Link sharing → ✉: a new email with the link, until when, and a word about the password', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Client receipts' })).body;
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Client receipts').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByLabel('File request (upload only)').check();
  await sec.getByLabel('Password').check();
  await sec.getByLabel('Link password').fill('secret-123');
  await sec.getByRole('button', { name: 'Create file request' }).click();
  const url = await sec.getByLabel('Share link').inputValue();
  await sec.getByRole('button', { name: 'Email link' }).click();
  await page.waitForURL(/\/mail/);
  const d = page.getByRole('dialog', { name: 'Please send me files: Client receipts' }).or(page.getByRole('dialog', { name: 'New message' }));
  await d.waitFor();
  if (await d.getByLabel('Subject').inputValue() !== 'Please send me files: Client receipts') throw new Error(await d.getByLabel('Subject').inputValue());
  const body = d.getByRole('textbox', { name: 'Message' });
  await body.getByRole('link', { name: url }).waitFor();
  const text = await body.innerText();
  if (!/send me your files for Client receipts/.test(text) || !/works until/.test(text) || !/send you separately/.test(text) || text.includes('secret-123')) throw new Error(text);
  await page.screenshot({ path: `${SP}/shots/linkemail.png` });
  if (!folder.id) throw new Error('folder');
});
await step('change a link’s expiry: the same link, until a new date, or for good', async () => {
  await api(page, 'POST', '/files/folder', { name: 'Brochures' });
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Brochures').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByLabel('Link expiry').selectOption({ label: 'Expires in 1 day' });
  await sec.getByRole('button', { name: 'Create link' }).click();
  const url = await sec.getByLabel('Share link').inputValue();
  const row = sec.locator('li', { has: page.getByLabel('Share link') });
  await sec.getByLabel('Change expiry').selectOption({ label: 'For 30 days' });
  await page.getByText('The link now works until').waitFor();
  const links = (await api(page, 'GET', '/files?view=mine')).body;
  const id = links.find((f) => f.name === 'Brochures').id;
  const l = (await api(page, 'GET', `/links?file=${id}`)).body[0];
  if (Math.abs(l.expires_at - Date.now() - 30 * 864e5) > 120e3) throw new Error(String(l.expires_at));
  if (!/Until /.test(await row.innerText())) throw new Error(await row.innerText());
  await sec.getByLabel('Change expiry').selectOption({ label: 'Never expires' });
  await page.getByText('The link now works until you remove it').waitFor();
  await row.getByText(/No expiry/).waitFor();
  if (await sec.getByLabel('Share link').inputValue() !== url) throw new Error('a different link');
});
await step('a link’s password: add one, it asks for it; remove it, it doesn’t', async () => {
  const sec = page.getByRole('region', { name: 'Link sharing' });
  const url = await sec.getByLabel('Share link').inputValue();
  await sec.getByRole('button', { name: 'Add a password' }).click();
  const d = page.getByRole('dialog', { name: 'Add a password to the link' });
  await d.getByLabel('New password').fill('abc');
  await d.getByRole('button', { name: 'Set password' }).click();
  await d.getByText('Use a password of at least 6 characters').waitFor();
  await d.getByLabel('New password').fill('harbour-42');
  await d.getByRole('button', { name: 'Set password' }).click();
  await page.getByText('Password set: send it separately from the link').waitFor();
  await sec.getByRole('button', { name: 'Remove password' }).waitFor();
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(url);
  await visitor.getByLabel(/Password/i).first().waitFor();
  await sec.getByRole('button', { name: 'Remove password' }).click();
  await page.getByText('Password removed').waitFor();
  await visitor.reload();
  await visitor.getByText('Brochures').first().waitFor();
  if (await visitor.getByLabel(/Password/i).count()) throw new Error('still asks');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
