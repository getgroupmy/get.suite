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
const rowBox = (s) => page.locator('.msg-list li', { hasText: s }).evaluate((el) => { const r = el.getBoundingClientRect(); const f = el.querySelector('.msg-from').getBoundingClientRect(); const sub = el.querySelector('.msg-subject').getBoundingClientRect(); return { h: Math.round(r.height), sameLine: Math.abs(f.top - sub.top) < 4 }; });
let usual;
await step('usual list: no pictures, two lines per email', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  for (let k = 0; k < 10; k++) { if ((await api(kim, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'From Kim', text: 'Hello' })).status === 200) break; await kim.waitForTimeout(1000); }
  await send('Note to self');
  await page.goto(`${B}/mail`);
  await row('From Kim').waitFor({ timeout: 40000 });
  await row('Note to self').waitFor({ timeout: 40000 });
  if (await page.locator('.msg-list .msg-pic').count()) throw new Error('pictures shown');
  usual = await rowBox('From Kim');
  if (usual.sameLine) throw new Error('one line');
});
await step('sender pictures, from Settings', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel(/Show sender pictures/).check();
  await page.getByText('Saved').first().waitFor();
  await page.goto(`${B}/mail`);
  const pic = page.locator('.msg-list li', { hasText: 'From Kim' }).locator('.msg-pic .avatar');
  await pic.waitFor({ timeout: 40000 });
  if ((await pic.innerText()).trim() !== 'KP') throw new Error(await pic.innerText());
  await page.screenshot({ path: `${SP}/shots/mail-pictures.png` });
});
await step('compact: one line per email, shorter rows', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel(/Compact list/).check();
  await page.getByText('Saved').first().waitFor();
  const me = (await api(page, 'GET', '/auth/me')).body.user.mail_list;
  if (!me.pictures || !me.compact) throw new Error(JSON.stringify(me));
  await page.goto(`${B}/mail`);
  await row('From Kim').waitFor({ timeout: 40000 });
  const c = await rowBox('From Kim');
  if (!c.sameLine || !(c.h < usual.h - 10)) throw new Error(JSON.stringify({ usual, c }));
  await page.screenshot({ path: `${SP}/shots/mail-compact.png` });
  await row('From Kim').click();
  await page.locator('.mail-reader').getByText('Hello').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
