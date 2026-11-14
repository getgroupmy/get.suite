import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
const max = await mk('max');
let code, notes;
await step('a meeting on an event with notes; Olivia and Max join and leave', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Weekly' })).body.code;
  const start = Date.now() + 5 * 60e3;
  const ev = (await api(page, 'POST', '/events', { title: 'Weekly review', start, end: start + 3600e3, meet_code: code, guests: ['max@acme.com'] })).body;
  notes = (await api(page, 'POST', `/events/${ev.id}/notes`, { tz: 'UTC' })).body;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: /^People/ }).click();
  await page.getByLabel('Keep the meeting chat').check();
  await page.getByRole('button', { name: /^Chat/ }).click();
  await page.getByLabel('Send a message to everyone').fill('Decision: ship Friday');
  await page.getByRole('button', { name: 'Send' }).click();
  await max.waitForTimeout(800);
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
});
await step('after it: 👥 Who joined → Follow-up email: to Max, “Follow-up: Weekly”, linking the notes', async () => {
  await page.getByRole('button', { name: /^👥 Who joined/ }).click();
  await page.getByRole('dialog', { name: 'Who joined Weekly' }).getByRole('button', { name: 'Follow-up email' }).click();
  await page.waitForURL(/\/mail/);
  const d = page.getByRole('dialog').filter({ has: page.getByLabel('Subject') });
  await d.waitFor({ timeout: 30000 });
  if (await d.getByLabel('Subject').inputValue() !== 'Follow-up: Weekly') throw new Error(await d.getByLabel('Subject').inputValue());
  await until(async () => (await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('max@acme.com'));
  if ((await d.evaluate((el) => [...el.querySelectorAll('input')].map((i) => i.value).join(' ') + el.innerText)).includes('olivia@acme.com')) throw new Error('not to yourself');
  const msg = d.getByRole('textbox', { name: 'Message' });
  await msg.getByText('Thanks for joining Weekly.').waitFor();
  const href = await msg.getByRole('link', { name: 'Meeting notes' }).getAttribute('href');
  if (href !== `${B}/docs/${notes.id}`) throw new Error(href);
  const chatHref = await msg.getByRole('link', { name: 'The meeting chat' }).getAttribute('href');
  if (chatHref !== `${B}/meet?chat=${code}`) throw new Error(chatHref);
  await max.goto(chatHref);
  await max.getByRole('dialog', { name: /^Chat from / }).getByText('Decision: ship Friday').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
