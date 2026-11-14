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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
});
const max = await mk('max');
let code;
const videoPlaying = (p, name) => p.evaluate((n) => { const v = document.querySelector(`video[aria-label="Video of ${n}"]`); return !!v && v.videoWidth > 0 && v.readyState >= 2; }, name);
await step('colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
});
await step('start a meeting; lobby shows the camera', async () => {
  await page.getByRole('link', { name: 'Meet', exact: true }).first().click();
  await page.getByLabel('Meeting name (optional)').fill('Standup');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  code = page.url().split('/meet/')[1];
  await page.getByRole('heading', { name: 'Standup' }).waitFor();
  await page.getByText('No one else is here yet').waitFor();
  await until(() => page.evaluate(() => { const v = document.querySelector('video[aria-label="Your camera"]'); return v && v.videoWidth > 0; }));
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
await step('colleague joins by code; both see each other', async () => {
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet`);
  await max.getByLabel('Meeting code or link').fill(code.toUpperCase().replace(/-/g, ' '));
  await max.getByRole('button', { name: 'Join', exact: true }).click();
  await max.getByText('Olivia Owner is here').waitFor();
  await max.getByRole('button', { name: 'Join now' }).click();
  await until(() => videoPlaying(page, 'Max Meet'), 20000);
  await until(() => videoPlaying(max, 'Olivia Owner'), 20000);
});
await step('Max asks two questions; Olivia is told there are new ones', async () => {
  await max.getByRole('button', { name: 'Questions', exact: true }).click();
  const mq = max.getByRole('complementary', { name: 'Questions' });
  await mq.getByText('No questions yet.').waitFor();
  await mq.getByLabel('Your question').fill('When is the offsite?');
  await mq.getByRole('button', { name: 'Ask' }).click();
  await mq.getByLabel('Your question').fill('Is there parking?');
  await mq.getByLabel('Your question').press('Enter');
  await mq.getByRole('listitem', { name: 'Question: Is there parking?' }).waitFor();
  if (!(await mq.getByRole('listitem', { name: 'Question: Is there parking?' }).getByRole('button', { name: /^Upvote/ }).isDisabled())) throw new Error('can upvote own');
  await page.getByRole('button', { name: 'Questions, 2 new' }).click();
});
await step('Olivia upvotes the second; it rises to the top for both', async () => {
  const oq = page.getByRole('complementary', { name: 'Questions' });
  await oq.getByRole('listitem', { name: 'Question: Is there parking?' }).getByRole('button', { name: 'Upvote, 0 votes' }).click();
  await oq.getByRole('listitem', { name: 'Question: Is there parking?' }).getByRole('button', { name: 'Upvote, 1 vote' }).waitFor();
  const mq = max.getByRole('complementary', { name: 'Questions' });
  await until(async () => (await mq.getByRole('listitem').first().getAttribute('aria-label')) === 'Question: Is there parking?');
  await until(async () => (await oq.getByRole('listitem').first().getAttribute('aria-label')) === 'Question: Is there parking?');
});
await step('the host marks it answered (it moves down); Max takes his other one away', async () => {
  const oq = page.getByRole('complementary', { name: 'Questions' });
  await oq.getByRole('listitem', { name: 'Question: Is there parking?' }).getByRole('button', { name: 'Mark answered' }).click();
  const mq = max.getByRole('complementary', { name: 'Questions' });
  await mq.getByText('You · answered').waitFor();
  await until(async () => (await mq.getByRole('listitem').first().getAttribute('aria-label')) === 'Question: When is the offsite?');
  await mq.getByRole('listitem', { name: 'Question: When is the offsite?' }).getByRole('button', { name: 'Take the question away' }).click();
  await until(async () => !(await oq.getByText('When is the offsite?').count()));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
