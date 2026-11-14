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
const width = () => page.locator('.mail-list').evaluate((el) => Math.round(el.getBoundingClientRect().width));
const divider = () => page.getByRole('separator', { name: 'Width of the message list' });
await step('drag the line to widen the list; kept after reloading', async () => {
  await send('Width check');
  await page.goto(`${B}/mail`);
  await row('Width check').waitFor({ timeout: 40000 });
  const w0 = await width();
  const box = await divider().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 200, { steps: 8 });
  await page.mouse.up();
  const w1 = await width();
  if (Math.abs(w1 - (w0 + 150)) > 8) throw new Error(`${w0} → ${w1}`);
  await until(async () => (await api(page, 'GET', '/auth/me')).body.user.mail_list_width === w1);
  await page.reload();
  await row('Width check').waitFor();
  if (Math.abs((await width()) - w1) > 2) throw new Error(`after reload ${await width()}`);
  await page.screenshot({ path: `${SP}/shots/mail-width.png` });
});
await step('arrow keys on it, limits, and double-click for the usual width', async () => {
  const w = await width();
  await divider().focus();
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await width()) === w - 20);
  const box = await divider().boundingBox();
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(10, box.y + 200, { steps: 5 });
  await page.mouse.up();
  if ((await width()) !== 260) throw new Error(`narrowest ${await width()}`);
  await divider().dblclick();
  await until(async () => (await api(page, 'GET', '/auth/me')).body.user.mail_list_width === null);
  if ((await width()) !== 380) throw new Error(`usual ${await width()}`);
});
await step('no line when the pane is below or off', async () => {
  await api(page, 'PUT', '/users/me/mail-pane', { pane: 'below' });
  await page.reload();
  await row('Width check').waitFor();
  if (await divider().count()) throw new Error('line shown');
  await api(page, 'PUT', '/users/me/mail-pane', { pane: 'right' });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
