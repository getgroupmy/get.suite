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
const max = await mk('max');
let ev, far;
await step('an event in 10 minutes with Max invited, and one next week', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  const start = Date.now() + 10 * 60e3;
  ev = (await api(page, 'POST', '/events', { title: 'Standup', start, end: start + 15 * 60e3, guests: ['max@acme.com'] })).body;
  far = (await api(page, 'POST', '/events', { title: 'Next week', start: start + 7 * 864e5, end: start + 7 * 864e5 + 60e3, guests: ['max@acme.com'] })).body;
  await signIn(max, 'max@acme.com');
  await page.goto(`${B}/drive`);
});
await step('Max: ⏱ Running late → 10 minutes; Olivia, elsewhere, is told and can open it', async () => {
  await max.goto(`${B}/calendar?event=${ev.id}`);
  const g = max.getByRole('group', { name: 'Running late' });
  await g.getByRole('button', { name: '⏱ Running late' }).click();
  await max.getByRole('menuitem', { name: '10 minutes late' }).click();
  await max.getByText('Everyone on it knows you’re running 10 minutes late').waitFor();
  await g.getByText('⏱ Max Meet: 10 min late').waitFor();
  await page.getByText('⏱ Max Meet is running 10 minutes late for “Standup”').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByRole('group', { name: 'Running late' }).getByText('⏱ Max Meet: 10 min late').waitFor();
});
await step('an event next week: no Running late yet', async () => {
  await max.goto(`${B}/calendar?event=${far.id}`);
  await max.getByRole('dialog', { name: 'Next week' }).waitFor();
  await max.waitForTimeout(800);
  if (await max.getByRole('button', { name: '⏱ Running late' }).count()) throw new Error('offered a week early');
}, max);
await step('a daily event: late today is shown on today’s, not on tomorrow’s', async () => {
  const start = Date.now() + 5 * 60e3;
  const daily = (await api(page, 'POST', '/events', { title: 'Daily check-in', start, end: start + 15 * 60e3, guests: ['max@acme.com'], rrule: { freq: 'daily' } })).body;
  await max.goto(`${B}/calendar?event=${daily.id}&at=${start}`);
  const g = max.getByRole('group', { name: 'Running late' });
  await g.getByRole('button', { name: '⏱ Running late' }).click();
  await max.getByRole('menuitem', { name: '5 minutes late', exact: true }).click();
  await g.getByText('⏱ Max Meet: 5 min late').waitFor();
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  await max.addScriptTag({ content: AXE });
  const res = await max.evaluate(async () => (await window.axe.run(document.querySelector('[role="dialog"]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 150)}`));
  if (res.length) throw new Error(res.join(' | '));
  await max.goto(`${B}/calendar?event=${daily.id}&at=${start + 864e5}`);
  await max.getByRole('dialog', { name: 'Daily check-in' }).waitFor();
  await max.waitForTimeout(800);
  if (await max.getByText('⏱ Max Meet: 5 min late').count()) throw new Error('shown on tomorrow’s');
  if (await max.getByRole('button', { name: '⏱ Running late' }).count()) throw new Error('offered for tomorrow');
}, max);
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
