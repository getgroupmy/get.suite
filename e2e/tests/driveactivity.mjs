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
let kim, kimId;
await step('Drive → Activity shows what others did to files Kim can open, by day; a name opens the file', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Team room' })).body.id;
  await api(page, 'PUT', `/files/${folder}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Roadmap', parent_id: folder })).body.id;
  await api(page, 'PATCH', `/files/${doc}`, { name: 'Roadmap 2027' });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Private diary' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.getByRole('link', { name: 'Activity' }).click();
  await kim.waitForURL(/\/drive\/activity/);
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const day = kim.getByRole('region', { name: today });
  await day.getByText('Olivia Owner renamed “Roadmap 2027” from Roadmap to Roadmap 2027').waitFor();
  await day.getByText('Olivia Owner shared “Team room” with Kim Park').waitFor();
  if (await kim.getByText('Private diary').count()) throw new Error('shows a file she can’t open');
  await kim.screenshot({ path: `${SP}/shots/drive-activity.png` });
  // Live: Olivia makes another; it shows up.
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget sheet', parent_id: folder });
  await day.getByText('Olivia Owner created “Budget sheet”').waitFor({ timeout: 10000 });
  await day.getByRole('button', { name: '“Roadmap 2027”' }).first().click();
  await kim.waitForURL(/\/docs\//);
});
await step('Olivia’s own doings aren’t in her Activity', async () => {
  await page.goto(`${B}/drive/activity`);
  await page.locator('.drive-activity, p.muted', { hasText: /Nothing new from others|Kim Park/ }).first().waitFor();
  if (await page.locator('.file-activity', { hasText: 'Olivia Owner created' }).count()) throw new Error('her own shown');
});
await step('narrowed to one person and one kind', async () => {
  const lenId = (await api(page, 'POST', '/users', { local: 'len', domain: 'acme.com', name: 'Len Lee', password: 'password123' })).body.id;
  const len = await mk('len'); await signIn(len, 'len@acme.com');
  const room = (await api(page, 'POST', '/files/folder', { name: 'Joint room' })).body.id;
  await api(page, 'PUT', `/files/${room}/shares`, { shares: [{ user_id: kimId, role: 'editor' }, { user_id: lenId, role: 'editor' }] });
  await api(len, 'POST', '/files/new', { kind: 'doc', name: 'Len notes', parent_id: room });
  await kim.goto(`${B}/drive/activity`);
  await kim.getByText('Len Lee created “Len notes”').waitFor();
  await kim.getByLabel('Who').selectOption({ label: 'Len Lee' });
  await until(async () => (await kim.locator('.file-activity', { hasText: 'Olivia Owner' }).count()) === 0);
  await kim.getByText('Len Lee created “Len notes”').waitFor();
  await kim.getByLabel('Who').selectOption({ label: 'Anyone' });
  await kim.getByLabel('What').selectOption({ label: 'Shared' });
  await kim.locator('.file-activity li', { hasText: /Olivia Owner shared “Joint room” with/ }).first().waitFor();
  if (await kim.getByText('Len Lee created').count()) throw new Error('kind not applied');
  await kim.getByLabel('Who').selectOption({ label: 'Len Lee' });
  await kim.getByText('Nothing like that in the last 30 days.').waitFor();
});
await step('Activity in the left bar counts what’s new; looking clears it; new entries are marked', async () => {
  await kim.goto(`${B}/drive`);
  const nav = kim.getByRole('link', { name: /^Activity/ });
  await until(async () => !(await nav.getByLabel(/new$/).count()));
  const room = (await api(page, 'POST', '/files/folder', { name: 'Fresh room' })).body.id;
  await api(page, 'PUT', `/files/${room}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await nav.getByLabel('2 new').waitFor({ timeout: 10000 });
  await kim.screenshot({ path: `${SP}/shots/drive-activity-count.png` });
  await nav.click();
  await kim.locator('.file-activity li.new', { hasText: 'Fresh room' }).first().waitFor();
  await kim.goto(`${B}/drive`);
  await kim.getByRole('link', { name: /^Activity/ }).waitFor();
  await kim.waitForTimeout(500);
  if (await kim.getByRole('link', { name: /^Activity/ }).getByLabel(/new$/).count()) throw new Error('still counted after looking');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
