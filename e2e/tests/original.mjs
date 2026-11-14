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
const fs = await import('node:fs');
await step('Show original: who sent it and how it was checked, the way it came, the headers; download as .eml', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.getByRole('button', { name: 'Compose' }).click();
  const d = page.getByRole('dialog', { name: 'New message' });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByLabel('Subject').fill('Invoice 2026-11');
  await d.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('The invoice details are below.');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  k.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(k, 'kim@acme.com');
  await k.locator('.mail-list').getByText('Invoice 2026-11', { exact: true }).click({ timeout: 40000 });
  await k.waitForTimeout(1500); await k.screenshot({ path: `${SP}/shots/kim-msg.png` });
  await k.getByRole('button', { name: 'More for this message' }).click({ timeout: 8000 });
  await k.getByRole('menuitem', { name: 'Show original' }).click();
  const o = k.getByRole('dialog', { name: 'Original message' });
  await o.getByRole('row', { name: /Message ID/ }).getByText(/^<.+@acme\.com>$/).waitFor();
  await o.getByRole('row', { name: /From/ }).getByText(/olivia@acme\.com/).waitFor();
  const headers = await o.getByLabel('Headers').inputValue();
  if (!/^Return-Path: <olivia@acme\.com>/m.test(headers) || !/DKIM-Signature: v=1;/.test(headers) || /The invoice details/.test(headers)) throw new Error(headers.slice(0, 300));
  await k.screenshot({ path: `${SP}/shots/original.png` });
  const [dl] = await Promise.all([k.waitForEvent('download'), o.getByRole('link', { name: 'Download message (.eml)' }).click()]);
  if (dl.suggestedFilename() !== 'Invoice 2026-11.eml') throw new Error(dl.suggestedFilename());
  const eml = fs.readFileSync(await dl.path(), 'utf8');
  if (!/Subject: Invoice 2026-11/.test(eml) || !/The invoice details are below\./.test(eml)) throw new Error('not the whole message');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
