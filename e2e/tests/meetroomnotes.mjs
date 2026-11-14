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
await step('an event with a video meeting; Olivia, its organiser, joins: 📝 Take meeting notes opens a new document', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Weekly' })).body.code;
  const start = Date.now() + 5 * 60e3;
  await api(page, 'POST', '/events', { title: 'Weekly review', start, end: start + 3600e3, meet_code: code, guests: ['max@acme.com'] });
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  const take = page.getByRole('button', { name: 'Take meeting notes' });
  await take.waitFor();
  const [doc] = await Promise.all([page.context().waitForEvent('page'), take.click()]);
  await doc.waitForURL(/\/docs\//);
  await doc.getByText('Weekly review').first().waitFor();
  await page.getByRole('button', { name: 'Open the meeting notes' }).waitFor();
  await doc.close();
});
await step('Max, a guest, joins: 📝 Open the meeting notes opens the same document', async () => {
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  const open = max.getByRole('button', { name: 'Open the meeting notes' });
  await open.waitFor();
  const [doc] = await Promise.all([max.context().waitForEvent('page'), open.click()]);
  await doc.waitForURL(/\/docs\//);
  await doc.getByText('Weekly review').first().waitFor();
}, max);
await step('a second event: Max is in it first; when Olivia starts the notes, his 📝 appears without rejoining', async () => {
  const code2 = (await api(page, 'POST', '/meet', { title: 'Retro' })).body.code;
  const start = Date.now() + 5 * 60e3;
  await api(page, 'POST', '/events', { title: 'Sprint retro', start, end: start + 3600e3, meet_code: code2, guests: ['max@acme.com'] });
  await max.goto(`${B}/meet/${code2}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await max.waitForTimeout(800);
  if (await max.getByRole('button', { name: /meeting notes/ }).count()) throw new Error('shown before there are notes');
  await page.goto(`${B}/meet/${code2}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  const [doc] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'Take meeting notes' }).click()]);
  await doc.waitForURL(/\/docs\//);
  await doc.close();
  await max.getByRole('button', { name: 'Open the meeting notes' }).waitFor({ timeout: 10000 });
}, max);
await step('a meeting without an event has no 📝', async () => {
  const plain = (await api(page, 'POST', '/meet', { title: 'Ad hoc' })).body.code;
  await page.goto(`${B}/meet/${plain}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.waitForTimeout(1000);
  if (await page.getByRole('button', { name: /meeting notes/ }).count()) throw new Error('shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
