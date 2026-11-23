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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

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

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
let q1, q2, b1, b2;
await step('From Drive in a task: two files with the same name say which folder each is in', async () => {
  q1 = (await api(page, 'POST', '/files/folder', { name: 'Q1 accounts' })).body;
  q2 = (await api(page, 'POST', '/files/folder', { name: 'Q2 accounts' })).body;
  b1 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', parent_id: q1.id })).body;
  b2 = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', parent_id: q2.id })).body;
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Loose memo' });
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Finance' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Check the budget' });
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { hasText: 'Check the budget' }).locator('.task-main').click();
  const d = page.getByRole('complementary', { name: 'Task details' });
  await d.getByRole('button', { name: 'From Drive' }).click();
  const pick = page.getByRole('dialog', { name: 'Attach to the task' });
  // Recent files, before anything is typed
  await pick.getByRole('button', { name: /Budget · in Q1 accounts/ }).waitFor();
  await pick.getByRole('button', { name: /Budget · in Q2 accounts/ }).waitFor();
  if (await pick.getByRole('button', { name: /Loose memo · in/ }).count()) throw new Error('a file at the top of My Drive says a folder');
  // and when searching
  await pick.getByLabel('Search your files').fill('budget');
  await until(async () => (await pick.getByRole('button', { name: /^Budget/ }).count()) === 2 && (await pick.getByRole('button', { name: /Loose memo/ }).count()) === 0);
  await pick.getByRole('button', { name: /Budget · in Q2 accounts/ }).click();
  const link = d.getByRole('list', { name: 'Files' }).getByRole('link', { name: 'Budget' });
  await link.waitFor();
  const href = await link.getAttribute('href');
  if (!href.includes(b2.id)) throw new Error('attached the wrong one: ' + href);
});
await step('Drive → Recent: each file says which folder it is in, and a click opens that folder', async () => {
  await page.goto(`${B}/drive/recent`);
  const row = page.locator('tr', { has: page.locator('.in-folder', { hasText: 'in Q1 accounts' }) });
  await row.locator('.name-text', { hasText: /^Budget/ }).waitFor();
  await page.locator('tr', { hasText: 'Loose memo' }).waitFor();
  if (await page.locator('tr', { hasText: 'Loose memo' }).locator('.in-folder').count()) throw new Error('Loose memo says a folder');
  await row.locator('.in-folder').click();
  await page.waitForURL(`**/drive/folder/${q1.id}`);
  await until(async () => (await page.locator('tbody tr', { hasText: 'Budget' }).count()) === 1 && (await page.locator('tbody tr', { hasText: 'Loose memo' }).count()) === 0);
});
await step('Drive → Starred: starred files say which folder they are in, and a click opens it', async () => {
  await api(page, 'PUT', `/files/${b2.id}/star`, { starred: true });
  const memo = (await api(page, 'GET', '/files?view=recent')).body.find((f) => f.name === 'Loose memo');
  await api(page, 'PUT', `/files/${memo.id}/star`, { starred: true });
  await page.goto(`${B}/drive/starred`);
  await page.locator('tbody .name-text', { hasText: /^Budget · in Q2 accounts/ }).waitFor();
  await page.locator('tbody tr', { hasText: 'Loose memo' }).waitFor();
  if (await page.locator('tbody tr', { hasText: 'Loose memo' }).locator('.in-folder').count()) throw new Error('Loose memo says a folder');
  await page.locator('tbody tr', { hasText: 'Budget' }).locator('.in-folder').click();
  await page.waitForURL(`**/drive/folder/${q2.id}`);
});
await step('Home → Recent files: each says which folder it is in', async () => {
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Recent files' });
  await card.getByRole('link', { name: 'Budget · in Q1 accounts' }).waitFor();
  await card.getByRole('link', { name: 'Budget · in Q2 accounts' }).waitFor();
  await card.getByRole('link', { name: 'Loose memo', exact: true }).waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
