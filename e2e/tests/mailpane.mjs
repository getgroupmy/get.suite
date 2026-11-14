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
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
const box = (sel) => page.locator(sel).evaluate((el) => { const r = el.getBoundingClientRect(); const v = getComputedStyle(el).display !== 'none'; return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), v }; });
await step('right of the list (the default)', async () => {
  for (const s of ['Pane alpha', 'Pane bravo']) { await send(s); await page.waitForTimeout(1200); }
  await page.goto(`${B}/mail`);
  await row('Pane bravo').waitFor({ timeout: 40000 });
  await row('Pane bravo').click();
  await reader().getByText('About Pane bravo').waitFor();
  const l = await box('.mail-list'), r = await box('.mail-reader');
  if (!(r.x >= l.x + l.w - 2 && Math.abs(r.y - l.y) < 4)) throw new Error(JSON.stringify({ l, r }));
});
await step('below the list, chosen in Settings', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel('Below the list').check();
  await page.getByText('Saved').first().waitFor();
  await page.goto(`${B}/mail`);
  await row('Pane alpha').click();
  await reader().getByText('About Pane alpha').waitFor();
  const l = await box('.mail-list'), r = await box('.mail-reader');
  if (!(r.y >= l.y + l.h - 2 && Math.abs(r.x - l.x) < 4 && l.w > 800)) throw new Error(JSON.stringify({ l, r }));
  await page.screenshot({ path: `${SP}/shots/mail-pane-below.png` });
});
await step('no split: the list fills the page; an email opens in its place, with back', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel(/No split/).check();
  await page.getByText('Saved').first().waitFor();
  await page.goto(`${B}/mail`);
  await row('Pane bravo').waitFor();
  const l = await box('.mail-list'), r = await box('.mail-reader');
  if (!(l.v && !r.v && l.w > 800)) throw new Error(JSON.stringify({ l, r }));
  await row('Pane bravo').click();
  await reader().getByText('About Pane bravo').waitFor();
  const l2 = await box('.mail-list'), r2 = await box('.mail-reader');
  if (!(!l2.v && r2.v && r2.w > 800)) throw new Error(JSON.stringify({ l2, r2 }));
  await page.screenshot({ path: `${SP}/shots/mail-pane-off.png` });
  await reader().getByRole('button', { name: 'Back to list' }).click();
  await row('Pane alpha').waitFor();
  if (await reader().isVisible()) throw new Error('reader still shown');
  // Phones keep showing one at a time whatever is chosen
  await page.setViewportSize({ width: 390, height: 800 });
  await row('Pane alpha').click();
  await reader().getByText('About Pane alpha').waitFor();
  if (await page.locator('.mail-list').isVisible()) throw new Error('list shown on a phone while reading');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
