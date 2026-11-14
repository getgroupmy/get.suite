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
const kim = await mk('kim');
let code, ev;
await step('an event with a video meeting; Olivia and Max join, chat is kept; Kim never joins', async () => {
  const maxId = (await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' })).body.id;
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  code = (await api(page, 'POST', '/meet', { title: 'Design review' })).body.code;
  const start = Date.now() - 30 * 60e3;
  const made = await api(page, 'POST', '/events', { title: 'Design review', start, end: start + 3600e3, meet_code: code, guests: ['max@acme.com', 'kim@acme.com'] });
  ev = made.body;
  if (!ev?.id) throw new Error(JSON.stringify(made));
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: /^People/ }).click();
  await page.getByLabel('Keep the meeting chat').check();
  await max.getByRole('button', { name: /^Chat/ }).click();
  await max.getByRole('complementary', { name: 'Meeting chat' }).getByText('is keeping this chat').waitFor();
  await max.getByLabel('Send a message to everyone').fill('Ship the blue version');
  await max.getByRole('button', { name: 'Send' }).click();
  await max.waitForTimeout(500);
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
});
await step('the organiser opens the event: Who joined (2) and Meeting chat (1)', async () => {
  await page.goto(`${B}/calendar?event=${ev.id}`);
  const line = page.getByRole('group', { name: 'Video meeting' });
  await line.getByRole('button', { name: 'Who joined (2)' }).click();
  const d = page.getByRole('dialog', { name: 'Who joined Design review' });
  await d.getByRole('table', { name: 'Attendance' }).getByText('Max Meet').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  await line.getByRole('button', { name: 'Meeting chat (1)' }).click();
  await page.getByRole('dialog', { name: 'Chat from Design review' }).getByText('Ship the blue version').waitFor();
});
await step('Max, a guest who was in it, sees them too', async () => {
  await max.goto(`${B}/calendar?event=${ev.id}`);
  await max.getByRole('group', { name: 'Video meeting' }).getByRole('button', { name: 'Meeting chat (1)' }).waitFor();
}, max);
await step('Kim, invited but never there, does not', async () => {
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar?event=${ev.id}`);
  const line = kim.getByRole('group', { name: 'Video meeting' });
  await line.getByRole('link', { name: /Join video meeting/ }).waitFor();
  await kim.waitForTimeout(800);
  if (await line.getByRole('button', { name: /Who joined|Meeting chat/ }).count()) throw new Error('shown to Kim');
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
