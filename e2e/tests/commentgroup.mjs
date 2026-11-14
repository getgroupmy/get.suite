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
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let doc, kim;
await step('a document shared with Kim', async () => {
  const k = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Budget' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: k.id, role: 'editor' }] });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Notifications/ }).click();
});
await step('Kim leaves three comments: one entry counting them, with the latest; it opens that comment', async () => {
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  let last, firstId;
  for (const body of ['Typo in line 2', 'Check the total', 'Source for this?']) {
    const r = await api(kim, 'POST', `/comments/${doc.id}`, { body, anchor: { quote: body } });
    if (r.status >= 300) throw new Error(JSON.stringify(r));
    last = r.body.comment;
    if (body.startsWith('Typo')) firstId = last.id;
    if (body.startsWith('Typo')) await panel.getByText('Kim Park commented on “Budget”').waitFor();
  }
  await panel.getByText('Kim Park left 3 comments on “Budget”').waitFor();
  await panel.getByText('The latest: Source for this?').waitFor();
  if (await panel.getByText('Kim Park commented on “Budget”').count()) throw new Error('the single one stays');
  await page.getByRole('button', { name: 'Notifications, 1 new' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/comments-grouped.png` });
  // Opened up: each comment's start, the latest first; one opens that very comment.
  await panel.getByRole('button', { name: 'Show all 3' }).click();
  const inside = panel.getByRole('list', { name: 'In “Kim Park left 3 comments on “Budget””' });
  const labels = await inside.getByRole('button').allInnerTexts();
  if (labels.join('|') !== 'Source for this?|Check the total|Typo in line 2') throw new Error(labels.join('|'));
  await inside.getByRole('button', { name: 'Typo in line 2' }).click();
  await page.waitForURL(new RegExp(`/docs/${doc.id}\\?comment=${firstId}`));
  await page.goBack();
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await panel.getByText('Kim Park left 3 comments on “Budget”').click();
  await page.waitForURL(new RegExp(`/docs/${doc.id}\\?comment=${last.id}`));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
