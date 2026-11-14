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
let ids = {};
await step('pick several people and set their department', async () => {
  for (const [local, name] of [['ann', 'Ann Lee'], ['bo', 'Bo Chen'], ['cy', 'Cy Diaz']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  await api(page, 'POST', '/groups', { name: 'Field team' });
  await page.goto(`${B}/admin`);
  await page.getByLabel('Select Ann Lee').check();
  await page.getByLabel('Select Bo Chen').check();
  const bar = page.getByRole('toolbar', { name: 'Selected people' });
  await bar.getByText('2 selected').waitFor();
  await bar.getByRole('button', { name: 'Set department…' }).click();
  await page.getByRole('dialog').getByLabel('Department', { exact: true }).fill('Field sales');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('2 people updated').waitFor();
  const card = (await api(page, 'GET', `/users/${ids.bo}/card`)).body;
  if (card.department !== 'Field sales') throw new Error(JSON.stringify(card));
});
await step('add them to a group, then suspend and restore them together', async () => {
  await page.getByLabel('Select Ann Lee').check();
  await page.getByLabel('Select Cy Diaz').check();
  const bar = page.getByRole('toolbar', { name: 'Selected people' });
  await bar.getByRole('button', { name: 'Add to group…' }).click();
  await page.getByRole('dialog', { name: /Add 2 people to a group/ }).getByRole('button', { name: 'Add' }).click();
  await page.getByText('Added to Field team').waitFor();
  const g = (await api(page, 'GET', '/groups')).body.find((x) => x.name === 'Field team');
  if (g.members.map((m) => m.id).sort().join() !== [ids.ann, ids.cy].sort().join()) throw new Error(JSON.stringify(g.members));
  await page.getByLabel('Select Bo Chen').check();
  await page.getByLabel('Select Cy Diaz').check();
  await bar.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('dialog', { name: 'Suspend 2 people?' }).getByRole('button', { name: 'Suspend' }).click();
  await page.getByText('Bo Chen (disabled)').waitFor();
  await page.getByText('Cy Diaz (disabled)').waitFor();
  await page.getByLabel('Select Bo Chen').check();
  await page.getByLabel('Select Cy Diaz').check();
  await bar.getByRole('button', { name: 'Restore' }).click();
  await until(async () => !(await page.getByText('(disabled)').count()));
});
await step('select everyone shown, then clear the selection', async () => {
  await page.getByLabel('Select everyone shown').check();
  const bar = page.getByRole('toolbar', { name: 'Selected people' });
  await bar.getByText('4 selected').waitFor();
  await bar.getByRole('button', { name: 'Clear' }).click();
  if (await bar.count()) throw new Error('still selected');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
