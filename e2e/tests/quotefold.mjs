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
const list = () => page.locator('.mail-list');
const frameText = () => page.frameLocator('iframe.mail-html').locator('body').innerText();
await step('a reply shows just its new part; ••• unfolds the quoted history', async () => {
  const html = '<p>Friday works for me.</p><p></p><p>On 9 Nov 2026, Kim Park wrote:</p><blockquote><p>Can we meet Friday about the budget?</p></blockquote>';
  if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Re: Budget meeting', html, text: 'Friday works for me.\n\nOn 9 Nov 2026, Kim Park wrote:\n> Can we meet Friday about the budget?' })).status !== 200) throw new Error('send');
  await list().getByText('Re: Budget meeting', { exact: true }).click({ timeout: 40000 });
  await until(async () => /Friday works for me/.test(await frameText()));
  if (/Can we meet Friday/.test(await frameText())) throw new Error('the quote shows');
  const toggle = page.getByRole('button', { name: 'Show quoted text' });
  await page.screenshot({ path: `${SP}/shots/quotefold.png` });
  await toggle.click();
  await until(async () => /Can we meet Friday about the budget/.test(await frameText()));
  await page.getByRole('button', { name: 'Hide quoted text' }).click();
  await until(async () => !/Can we meet Friday/.test(await frameText()));
});
await step('plain text: the "> " lines fold away too; a message with no quote has no button', async () => {
  if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Re: Keys', text: 'Left them at reception.\n\nOn Mon, Kim wrote:\n> Where are the keys?\n> Kim' })).status !== 200) throw new Error('send');
  if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Plain hello', text: 'Just saying hello.' })).status !== 200) throw new Error('send');
  await list().getByText('Re: Keys', { exact: true }).click({ timeout: 40000 });
  const pre = page.locator('pre.mail-text');
  await until(async () => (await pre.innerText()).trim() === 'Left them at reception.');
  await page.getByRole('button', { name: 'Show quoted text' }).click();
  await until(async () => /Where are the keys/.test(await pre.innerText()));
  await list().getByText('Plain hello', { exact: true }).click({ timeout: 40000 });
  await until(async () => /Just saying hello/.test(await pre.innerText()));
  if (await page.getByRole('button', { name: /quoted text/ }).count()) throw new Error('a button with nothing to fold');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
