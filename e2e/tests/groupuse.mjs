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
const ids = {};
await step('a group of two', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Chan']]) ids[local] = (await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).body.id;
  const g = (await api(page, 'POST', '/groups', { name: 'Sales team' })).body;
  const r = await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [ids.kim, ids.lee] });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
});
await step('calendar: invite a group adds everyone in it', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Pipeline review');
  await dlg.getByLabel('Invite a group').selectOption({ label: 'Sales team (2)' });
  await dlg.getByRole('button', { name: 'Remove kim@acme.com' }).waitFor();
  await dlg.getByRole('button', { name: 'Remove lee@acme.com' }).waitFor();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await until(async () => { const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5 * 2}&to=${Date.now() + 864e5 * 9}`)).body; const e = evs.find((x) => x.title === 'Pipeline review'); return e && e.guests?.length === 2; });
});
await step('chat: a private channel with a group', async () => {
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: 'New channel' }).click();
  const d = page.getByRole('dialog', { name: 'New channel' });
  await d.getByLabel('Channel name').fill('deals');
  await d.getByLabel(/Private: only/).check();
  await d.getByRole('group', { name: 'Add a group' }).getByRole('button', { name: '+ Sales team (2)' }).click();
  for (const n of ['Kim Park', 'Lee Chan']) if (!(await d.getByLabel(new RegExp(n)).isChecked())) throw new Error(n);
  await d.getByRole('button', { name: /Create/ }).click();
  await d.waitFor({ state: 'detached' });
  const ch = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'deals');
  if (!ch || !ch.private || ch.member_count !== 3) throw new Error(JSON.stringify(ch));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
