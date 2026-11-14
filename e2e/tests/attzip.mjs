import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import fs from 'node:fs';
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
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
await step('Download all: the attachments of a message in one zip, named after it', async () => {
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const a = await upload('quote.txt', 'Price: 120');
  const b = await upload('quote.txt', 'Price: 95 (revised)');
  const c = await upload('terms.txt', 'Net 30');
  if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Supplier quotes', text: 'Attached.', attachments: [a.id, b.id, c.id] })).status !== 200) throw new Error('send');
  await page.locator('.mail-list').getByText('Supplier quotes', { exact: true }).click({ timeout: 40000 });
  const link = page.getByRole('link', { name: 'Download all (.zip)' });
  await link.waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  if (dl.suggestedFilename() !== 'Supplier quotes (attachments).zip') throw new Error(dl.suggestedFilename());
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const names = Object.keys(zip.files).sort().join('|');
  if (names !== 'quote (1).txt|quote.txt|terms.txt') throw new Error(names); // (Drive named the second upload "quote (1)")
  if (await zip.file('quote (1).txt').async('string') !== 'Price: 95 (revised)') throw new Error('content');
  await page.screenshot({ path: `${SP}/shots/attzip.png` });
});
await step('one attachment: no Download all', async () => {
  const d = await upload('single.txt', 'x');
  await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Just one', text: 'Here.', attachments: [d.id] });
  await page.locator('.mail-list').getByText('Just one', { exact: true }).click({ timeout: 40000 });
  await page.locator('a.att', { hasText: 'single.txt' }).waitFor();
  if (await page.getByRole('link', { name: 'Download all (.zip)' }).count()) throw new Error('shown for one');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
