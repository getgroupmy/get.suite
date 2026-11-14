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
let kim;
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
let doc, vic;
await step('a commenter reacts to a comment; the others see it live', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const vicId = (await api(page, 'POST', '/users', { local: 'vic', domain: 'acme.com', name: 'Vic Viewer', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'commenter' }, { user_id: vicId, role: 'viewer' }] });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Shall we ship on Friday?', anchor: { quote: 'ship' }, id: 'thread-react-1' });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Comments' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.getByText('Shall we ship on Friday?').waitFor();
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('button', { name: 'Comments' }).first().click();
  const kp = kim.getByRole('complementary', { name: 'Comments' });
  await kp.getByText('Shall we ship on Friday?').waitFor();
  await kp.getByRole('button', { name: 'Add a reaction' }).click();
  await kp.getByRole('button', { name: 'React with 👍' }).click();
  await kp.getByRole('button', { name: '👍 1: Kim Park' }).waitFor();
  // Olivia sees it live, and adds hers to it.
  const thumbs = panel.getByRole('button', { name: /^👍 1: Kim Park/ });
  await thumbs.waitFor({ timeout: 10000 });
  await thumbs.click();
  await panel.getByRole('button', { name: '👍 2: Kim Park, Olivia Owner' }).waitFor();
  if (await panel.getByRole('button', { name: /^👍 2/ }).getAttribute('aria-pressed') !== 'true') throw new Error('mine');
  await page.screenshot({ path: `${SP}/shots/comment-react.png` });
  // Taking hers back.
  await panel.getByRole('button', { name: /^👍 2/ }).click();
  await panel.getByRole('button', { name: '👍 1: Kim Park' }).waitFor();
});
await step('a viewer sees reactions but can’t add one', async () => {
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  await vic.goto(`${B}/docs/${doc.id}`);
  await vic.getByRole('button', { name: 'Comments' }).first().click();
  const vp = vic.getByRole('complementary', { name: 'Comments' });
  await vp.getByRole('button', { name: '👍 1: Kim Park' }).waitFor();
  if (await vp.getByRole('button', { name: 'Add a reaction' }).count()) throw new Error('viewer can react');
  if (await vp.getByRole('button', { name: '👍 1: Kim Park' }).isEnabled()) throw new Error('viewer can toggle');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
