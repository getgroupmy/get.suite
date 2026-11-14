import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
await step('Drive: moving between folders quickly, the folder you left answering last doesn’t take over', async () => {
  const a = (await api(page, 'POST', '/files/folder', { name: 'Alpha folder' })).body.id;
  const b = (await api(page, 'POST', '/files/folder', { name: 'Beta folder' })).body.id;
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Only in Alpha', parent_id: a });
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Only in Beta', parent_id: b });
  await page.goto(`${B}/drive/folder/${b}`);
  await page.getByText('Only in Beta').waitFor();
  await page.route((u) => u.pathname === '/api/files' && u.searchParams.get('parent') === a, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  // Beta → My Drive → open Alpha (its answer late) → Back, Back: Beta again, before Alpha has answered.
  await page.getByRole('button', { name: 'My Drive' }).first().click();
  await page.locator('table.files tbody tr', { hasText: 'Alpha folder' }).dblclick();
  await page.waitForTimeout(150);
  await page.goBack(); await page.goBack();
  await until(async () => page.url().endsWith(b));
  await page.getByText('Only in Beta').waitFor();
  await page.waitForTimeout(2500);
  if (await page.getByText('Only in Alpha').count()) throw new Error('Alpha’s file shown in Beta');
});
await step('Chat: switching conversations quickly, the one you left answering last doesn’t take over', async () => {
  const one = (await api(page, 'POST', '/chat/channels', { name: 'first-room' })).body.id;
  const two = (await api(page, 'POST', '/chat/channels', { name: 'second-room' })).body.id;
  await api(page, 'POST', `/chat/channels/${one}/messages`, { body: 'said in the first room' });
  await api(page, 'POST', `/chat/channels/${two}/messages`, { body: 'said in the second room' });
  await page.goto(`${B}/chat/${two}`);
  await page.getByText('said in the second room').waitFor();
  await page.route(new RegExp(`/api/chat/channels/${one}/messages$`), async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.getByRole('button', { name: /first-room/ }).first().click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: /second-room/ }).first().click();
  await page.getByText('said in the second room').waitFor();
  await page.waitForTimeout(2500);
  if (await page.getByText('said in the first room').count()) throw new Error('the first room’s messages shown in the second');
});
await step('Calendar: going through weeks quickly, a week you left answering last doesn’t take over', async () => {
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  await api(page, 'POST', '/events', { title: 'This week meeting', start: at(0, 23) - 30 * 60e3, end: at(0, 23) });
  await api(page, 'POST', '/events', { title: 'Next week meeting', start: at(7, 23) - 30 * 60e3, end: at(7, 23) });
  await api(page, 'PUT', '/users/me/keys', { on: true });
  // This week's request: the one for seven days (the 30-day one is the upcoming list).
  const isWeek = (u) => { const f = Number(u.searchParams.get('from')), t = Number(u.searchParams.get('to')); return u.pathname === '/api/events' && t - f <= 8 * 864e5; };
  let thisWeek = null;
  page.on('request', (r) => { const u = new URL(r.url()); if (!thisWeek && isWeek(u)) thisWeek = u.searchParams.get('from'); });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radiogroup', { name: 'View' }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('w');
  await page.getByText('This week meeting').first().waitFor();
  thisWeek = null; await page.reload(); await page.getByText('This week meeting').first().waitFor();
  const slowFrom = thisWeek;
  await page.route((u) => isWeek(u) && u.searchParams.get('from') === slowFrom, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('k'); await page.waitForTimeout(150);
  await page.keyboard.press('j'); await page.waitForTimeout(150); // this week again: its answer will be late
  await page.keyboard.press('j');
  // (The sidebar's Upcoming list shows both whatever week is on screen: look in the week itself.)
  const grid = page.locator('.timegrid');
  await grid.getByText('Next week meeting').first().waitFor();
  await page.waitForTimeout(2500);
  if (await grid.getByText('This week meeting').count()) throw new Error('this week’s event shown in next week');
  if (!(await grid.getByText('Next week meeting').count())) throw new Error('next week’s event gone');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
