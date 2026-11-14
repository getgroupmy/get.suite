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
let kim, group;
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
await step('a colleague in a group', async () => {
  const k = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  group = (await api(page, 'POST', '/groups', { name: 'Night shift' })).body;
  await api(page, 'PUT', `/groups/${group.id}/members`, { user_ids: [k.body.id] });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
});
await step('an announcement for one group: its members see it, others don\'t', async () => {
  await page.goto(`${B}/admin?tab=announcements`);
  await page.getByLabel('Announcement', { exact: true }).fill('New rota for the night shift');
  await page.getByLabel('Who sees it').selectOption({ label: 'Night shift (1)' });
  await page.getByRole('button', { name: 'Post' }).click();
  await page.getByText('Announcement posted: everyone in Night shift sees it now').waitFor();
  await page.getByRole('list', { name: 'Current announcements' }).getByText(/for Night shift \(1\)/).waitFor();
  await kim.getByRole('region', { name: 'Announcements' }).getByText('New rota for the night shift').waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.waitForTimeout(500);
  if (await page.getByText('New rota for the night shift').count()) throw new Error('shown to someone outside the group');
});
let start;
await step('scheduled for later: listed under Scheduled, not shown yet', async () => {
  const d = new Date(Date.now() + 60e3); d.setSeconds(0, 0); // the next whole minute, at least a few seconds ahead
  if (d.getTime() - Date.now() < 15e3) d.setMinutes(d.getMinutes() + 1);
  start = d.getTime();
  await page.goto(`${B}/admin?tab=announcements`);
  await page.getByLabel('Announcement', { exact: true }).fill('Maintenance tonight from 22:00');
  await page.getByLabel('Starts').fill(localInput(d));
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByText(/Announcement scheduled: everyone in the company sees it from/).waitFor();
  const sched = page.getByRole('list', { name: 'Scheduled announcements' });
  await sched.getByText('Maintenance tonight from 22:00').waitFor();
  await sched.getByRole('button', { name: 'Cancel' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/announce-scheduled.png` });
  if (await kim.getByText('Maintenance tonight from 22:00').count()) throw new Error('shown before it starts');
});
await step('when it starts, it appears in open tabs without reloading, and moves to Showing now', async () => {
  await kim.getByRole('region', { name: 'Announcements' }).getByText('Maintenance tonight from 22:00').waitFor({ timeout: start - Date.now() + 90e3 });
  if (Date.now() < start) throw new Error('shown early');
  await page.getByRole('list', { name: 'Current announcements' }).getByText('Maintenance tonight from 22:00').waitFor({ timeout: 10e3 });
  await kim.screenshot({ path: `${SP}/shots/announce-started.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
