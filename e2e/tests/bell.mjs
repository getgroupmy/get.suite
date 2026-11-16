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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let kim, kimId;
const bell = (p) => p.getByRole('button', { name: /^Notifications/ });
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
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await bell(kim).waitFor();
});
await step('things Olivia does for Kim show on Kim’s bell at once', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Budget notes' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  const gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await api(page, 'POST', `/chat/channels/${gen}/messages`, { body: 'Thanks @kim@acme.com!' });
  await kim.getByRole('button', { name: 'Notifications, 2 new' }).waitFor({ timeout: 60000 }); // live; slow when many tests run at once
  await bell(kim).click();
  const panel = kim.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Olivia Owner shared “Budget notes” with you').waitFor();
  await panel.getByText('Olivia Owner mentioned you in #general').waitFor();
  await kim.screenshot({ path: `${SP}/shots/bell.png` });
});
await step('opening one goes there and marks it read', async () => {
  await kim.getByRole('dialog', { name: 'Notifications' }).getByText('Olivia Owner shared “Budget notes” with you').click();
  await kim.waitForURL(/\/docs\//);
  await kim.goBack();
  await kim.getByRole('button', { name: 'Notifications, 1 new' }).waitFor();
});
await step('mark all read; the count stays gone after a reload', async () => {
  await bell(kim).click();
  await kim.getByRole('button', { name: 'Mark all read' }).click();
  await kim.getByRole('button', { name: 'Notifications', exact: true }).waitFor();
  await kim.reload();
  await kim.getByRole('button', { name: 'Notifications', exact: true }).waitFor();
});
await step('Olivia’s own bell stays quiet', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Notifications', exact: true }).waitFor();
});
await step('a notification that arrives live while the bell’s list is still loading isn’t lost when the (older) list lands', async () => {
  const slow = await mk('kim-slow');
  await signIn(slow, 'kim@acme.com');
  // The bell's list requests are answered by the server at once but handed to the page only when released:
  // answers from before the notification, arriving after it.
  const held = []; let release = false;
  await slow.route(/\/api\/notifications$/, async (route) => {
    if (release || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    held.push(() => route.fulfill({ response }));
  });
  await slow.goto(`${B}/drive`);
  const end = Date.now() + 15000;
  while (held.length < 2 && Date.now() < end) await slow.waitForTimeout(100); // the first load, and the one when the live connection opens
  if (held.length < 2) throw new Error(`only ${held.length} list requests held`);
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Race notes' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await slow.waitForTimeout(1500); // the live notification has arrived
  release = true;
  for (const f of held) await f();
  await slow.waitForTimeout(1500);
  await bell(slow).click();
  await slow.getByRole('dialog', { name: 'Notifications' }).getByText('Olivia Owner shared “Race notes” with you').waitFor({ timeout: 10000 });
}, undefined);
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
