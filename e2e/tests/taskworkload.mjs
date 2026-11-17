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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label, p = page) => {
  await p.waitForTimeout(300);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label, p = page) => { await p.emulateMedia({ colorScheme: 'light' }); await scan(`${label} light`, p); await p.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`, p); await p.emulateMedia({ colorScheme: 'light' }); };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
let list;
await step('a shared list: Workload shows each person’s open tasks by when they’re due', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kimId = (await api(page, 'GET', '/users')).body.find((u) => u.name === 'Kim Park').id;
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body;
  await api(page, 'PUT', `/tasks/lists/${list.id}/members`, { user_ids: [kimId] });
  for (const [title, extra] of [['Write the press release', { due: day(-3), assignee_id: kimId }], ['Book the venue', { due: day(0), assignee_id: kimId }], ['Order banners', {}], ['Brief the team', { due: day(40) }]]) {
    await api(page, 'POST', `/tasks/lists/${list.id}/tasks`, { title, ...extra });
  }
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByText('Write the press release').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Workload…' }).click();
  const table = page.getByRole('dialog', { name: 'Workload on “Launch”' }).getByRole('table', { name: 'Workload' });
  await table.waitFor();
  const cells = async (name) => (await table.getByRole('row', { name: new RegExp(`^${name}`) }).getByRole('cell').allTextContents()).map((x) => x.trim());
  const kim = await cells('Kim Park');
  if (kim[0] !== '2' || kim[1] !== '1' || kim[2] !== '1') throw new Error(`Kim: ${kim}`);
  const none = await cells('Not assigned');
  if (none[0] !== '2' || none[4] !== '1' || none[5] !== '1') throw new Error(`Not assigned: ${none}`);
  if ((await cells('Olivia Owner'))[0] !== '0') throw new Error('owner');
  await page.screenshot({ path: `${SP}/shots/workload.png` });
  await both('workload');
});
await step('a name in Workload shows only their tasks; a task added then is theirs', async () => {
  await page.getByRole('table', { name: 'Workload' }).getByRole('button', { name: 'Kim Park' }).click();
  await page.waitForURL(/who=/);
  await until(async () => (await page.getByLabel('Show tasks for').inputValue()) !== '');
  await page.getByText('Write the press release').waitFor();
  if (await page.getByText('Order banners').count()) throw new Error('someone else’s task shown');
  await page.getByPlaceholder('Add a task').fill('Send the invitations');
  await page.keyboard.press('Enter');
  await page.getByText('Send the invitations').waitFor();
  const t = (await api(page, 'GET', `/tasks/lists/${list.id}/tasks`)).body.find((x) => x.title === 'Send the invitations');
  if (!t?.assignee_id) throw new Error('not given to Kim');
  await page.getByLabel('Show tasks for').selectOption({ label: 'Not assigned' });
  await page.getByText('Order banners').waitFor();
  if (await page.getByText('Write the press release').count()) throw new Error('Kim’s task among the unassigned');
  await page.getByRole('button', { name: 'Show everyone' }).click();
  await page.getByText('Write the press release').waitFor();
  await page.getByText('Order banners').waitFor();
  await both('tasks for one person');
});
await step('a list nobody shares has no Workload', async () => {
  const solo = (await api(page, 'POST', '/tasks/lists', { name: 'Just mine' })).body;
  await page.goto(`${B}/tasks/${solo.id}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Time report…' }).waitFor();
  if (await page.getByRole('menuitem', { name: 'Workload…' }).count()) throw new Error('offered on a list nobody shares');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
