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
const kim = await mk('kim');
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label, p = page) => {
  await p.waitForTimeout(300);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label, p = page) => { await p.emulateMedia({ colorScheme: 'light' }); await scan(`${label} light`, p); await p.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`, p); await p.emulateMedia({ colorScheme: 'light' }); };
let kimId, list, task;
await step('setup: a colleague, a list with time on it', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Client work' })).body.id;
  task = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Design' })).body.id;
  await api(page, 'POST', `/tasks/tasks/${task}/time`, { duration: '1h 30m' });
  await api(page, 'PUT', `/tasks/lists/${list}/rate`, { rate: 80, currency: 'EUR' });
});
await step('a person’s card: Say thanks form, then Thanks received with 👏 and ✕', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.getByRole('button', { name: 'Kim Park', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Kim Park' });
  await card.getByRole('button', { name: '🙌 Say thanks' }).click();
  await card.getByRole('form', { name: 'Thank Kim Park' }).getByLabel('What for').fill('Great work');
  await card.getByLabel('Also post in').waitFor();
  await both('thanks form');
  await card.getByRole('button', { name: 'Send thanks' }).click();
  await card.getByRole('list', { name: 'Thanks received' }).waitFor();
  await both('thanks received');
  await page.keyboard.press('Escape');
});
await step('Home: the Thanks card with 👏', async () => {
  await page.goto(`${B}/home`);
  await page.getByRole('region', { name: 'Thanks' }).waitFor({ timeout: 10000 });
  await both('home thanks');
});
await step('Tasks: My timesheet', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'My timesheet' }).click();
  await page.getByRole('table', { name: 'Timesheet' }).waitFor({ timeout: 10000 });
  await page.getByRole('table', { name: 'Timesheet' }).getByRole('button', { name: /^Design, / }).first().click();
  await page.getByRole('form', { name: 'Add time' }).waitFor();
  await both('timesheet');
  await page.keyboard.press('Escape');
});
await step('Tasks: time report at a rate, and its rate form', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Time report…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Time on “Client work”' });
  await dlg.getByRole('columnheader', { name: 'Amount' }).waitFor({ timeout: 10000 });
  await both('time report');
  await dlg.getByRole('button', { name: 'Change rate' }).click();
  await dlg.getByRole('form', { name: 'Hourly rate' }).waitFor();
  await both('rate form');
  await page.keyboard.press('Escape');
});
await step('the top-bar timer and “You were away”', async () => {
  await page.evaluate(() => localStorage.setItem('nw-away-seconds', '2'));
  await api(page, 'POST', `/tasks/tasks/${task}/timer`);
  await page.goto(`${B}/drive`);
  await page.getByRole('status', { name: /^Design:/ }).waitFor({ timeout: 10000 });
  await page.mouse.move(100, 100);
  await page.waitForTimeout(5500);
  await page.mouse.move(200, 200);
  await page.getByRole('dialog', { name: 'You were away' }).waitFor({ timeout: 5000 });
  await both('away dialog');
  await page.getByRole('button', { name: 'Leave it out and stop' }).click();
  await page.evaluate(() => localStorage.removeItem('nw-away-seconds'));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
