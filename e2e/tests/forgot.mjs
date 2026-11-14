import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 300)); } };
let kim, link;
await step('Fay adds a recovery address in Settings', async () => {
  for (const [local, name] of [['fay', 'Fay Forgetful'], ['kim', 'Kim Park']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const ctx = await browser.newContext(); const fay = await ctx.newPage();
  await fay.goto(B);
  await fay.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fay@acme.com', password: 'password123' }) }));
  await fay.goto(`${B}/settings`);
  const card = fay.getByRole('form', { name: 'Recovery email' }).or(fay.locator('form[aria-labelledby="rec-h"]'));
  await card.getByLabel('Recovery address').fill('kim@acme.com');
  await card.getByLabel('Your password (to confirm it’s you)').or(card.getByLabel("Your password (to confirm it's you)")).fill('password123');
  await card.getByRole('button', { name: 'Save' }).click();
  await fay.getByText('Recovery address saved: kim@acme.com').waitFor();
  await ctx.close();
  const kctx = await browser.newContext(); kim = await kctx.newPage();
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
});
await step('Forgot password? on the sign-in page emails a link to that address', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`anon: ${e.message}`));
  await p.goto(B);
  await p.getByRole('button', { name: 'Forgot password?' }).click();
  await p.getByLabel('Email address').fill('fay@acme.com');
  await p.getByRole('button', { name: 'Send me a link' }).click();
  await p.getByText(/If that account has a recovery address, a link to choose a new password is on its way/).waitFor();
  const msg = await until(async () => { const r = await api(kim, 'GET', '/mail/messages?folder=INBOX'); return r.body?.messages?.find((m) => m.subject === 'Reset your Workspace password'); }, 40000);
  const full = (await api(kim, 'GET', `/mail/messages/${msg.uid}?folder=INBOX`)).body;
  if (full.from.address !== 'fay@acme.com') throw new Error(JSON.stringify(full.from));
  link = /(https?:\/\/\S+\/reset\/[A-Za-z0-9_-]+)/.exec(full.text)[1];
  await ctx.close();
});
await step('the link lets Fay choose a new password once, then sign in with it', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`reset: ${e.message}`));
  await p.goto(link.replace(/^https?:\/\/[^/]+/, B));
  await p.getByText('For fay@acme.com').waitFor();
  await p.getByLabel('New password', { exact: true }).fill('brand new pass 9');
  await p.getByLabel('Confirm new password').fill('brand new pass 9');
  await p.getByRole('button', { name: 'Change password' }).click();
  await p.getByText(/Your password is changed/).waitFor();
  await p.goto(link.replace(/^https?:\/\/[^/]+/, B));
  await p.getByText(/expired or been used/).waitFor();
  await p.goto(B);
  await p.getByLabel('Email address').fill('fay@acme.com');
  await p.getByLabel('Password').fill('brand new pass 9');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).waitFor();
  await ctx.close();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
