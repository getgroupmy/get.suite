import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
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
await step('Olivia and Max are in a video meeting together, then leave', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  const code = (await api(page, 'POST', '/meet', { title: 'Weekly' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await max.waitForTimeout(800);
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.waitForTimeout(500);
  // Make Olivia's time there 65 minutes (the test can't wait an hour).
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  db.prepare("UPDATE meeting_attendance SET joined_at = left_at - 65 * 60000 WHERE email = 'olivia@acme.com'").run();
  db.close();
});
await step('Admin → Reports: Video meetings and Time in video meetings, with totals; sortable', async () => {
  await page.goto(`${B}/admin?tab=reports`);
  const table = page.locator('table', { has: page.getByRole('button', { name: 'Video meetings' }) });
  await table.waitFor();
  const head = await table.locator('thead th').allInnerTexts();
  if (!head.includes('Video meetings') || !head.includes('Time in video meetings')) throw new Error(head.join('|'));
  const col = (name) => head.indexOf(name);
  const row = async (who) => (await table.locator('tbody tr', { hasText: who }).locator('td, th').allInnerTexts());
  const o = await row('Olivia Owner'), m = await row('Max Meet');
  if (o[col('Video meetings')] !== '1' || o[col('Time in video meetings')] !== '1 h 5 min') throw new Error(JSON.stringify(o));
  if (m[col('Video meetings')] !== '1' || m[col('Time in video meetings')] !== '0') throw new Error(JSON.stringify(m));
  const foot = await table.locator('tfoot th').allInnerTexts();
  if (foot[col('Video meetings')] !== '2' || foot[col('Time in video meetings')] !== '1 h 5 min') throw new Error(JSON.stringify(foot));
  await table.getByRole('button', { name: 'Time in video meetings' }).click();
  const first = await table.locator('tbody tr').first().innerText();
  if (!/Olivia Owner/.test(first)) throw new Error(`sorted: ${first}`);
  const csv = await page.evaluate(async () => (await fetch('/api/users/report?format=csv')).text());
  if (!/Video meetings joined,Minutes in video meetings/.test(csv) || !/Olivia Owner,olivia@acme\.com,[^,]+,\d+,\d+,\d+,\d+,\d+,1,65,/.test(csv)) throw new Error(csv);
});
await step('the Video meetings summary: 1 meeting, the time in it, its length, no guests', async () => {
  const sec = page.getByRole('region', { name: 'Video meetings' });
  const stat = async (name) => (await sec.locator('div', { has: page.locator('dt', { hasText: name }) }).locator('dd').innerText());
  const got = [await stat('Meetings held'), await stat('Time in them'), await stat('Average length'), await stat('Guests without an account')];
  if (got[0] !== '1' || got[1] !== '1 h 5 min' || got[2] !== '1 h 5 min' || got[3] !== '0') throw new Error(JSON.stringify(got));
});
await step('axe: the Reports page with the meeting figures', async () => {
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 150)}`));
  if (res.length) throw new Error(res.join(' | '));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
