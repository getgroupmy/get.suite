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
let kim, doc;
await step('a reply to Kim’s comment lands on her bell and opens the thread; Olivia hears of Kim’s new comment', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Reply plan' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/home`);
  await kim.getByRole('button', { name: /^Notifications/ }).waitFor();
  const made = (await api(kim, 'POST', `/comments/${doc.id}`, { body: 'Should we cut this part?', anchor: { quote: 'p' }, id: 'thread-reply-1' })).body;
  if (!made.comment) throw new Error('no comment');
  await page.goto(`${B}/home`);
  await page.getByRole('button', { name: 'Notifications, 1 new' }).click();
  await page.getByRole('dialog', { name: 'Notifications' }).getByText('Kim Park commented on “Reply plan”').waitFor();
  await page.keyboard.press('Escape');
  // Olivia replies in the document.
  await page.goto(`${B}/docs/${doc.id}?comment=thread-reply-1`);
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByRole('textbox', { name: 'Reply' }).fill('Yes, cut it');
  await panel.getByRole('button', { name: 'Reply', exact: true }).click();
  await panel.getByText('Yes, cut it').waitFor();
  // Kim's bell, live.
  await kim.getByRole('button', { name: 'Notifications, 2 new' }).click(); // the share, then the reply
  const kb = kim.getByRole('dialog', { name: 'Notifications' });
  await kb.getByText('Olivia Owner replied to a comment on “Reply plan”').waitFor();
  await kim.screenshot({ path: `${SP}/shots/comment-reply-bell.png` });
  await kb.getByText('Olivia Owner replied to a comment on “Reply plan”').click();
  await kim.waitForURL(/\/docs\/.+\?comment=thread-reply-1/);
  await kim.locator('.comment-thread.active', { hasText: 'Yes, cut it' }).waitFor();
});
await step('replies can be turned off in the bell’s settings', async () => {
  const off = (await api(kim, 'GET', '/notifications/settings')).body.kinds.find((k) => k.kind === 'reply');
  if (!off || !/Replies in comment threads/.test(off.label)) throw new Error('no such setting');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
