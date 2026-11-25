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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label, p = page) => {
  await p.waitForTimeout(300);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label, p = page) => { await p.emulateMedia({ colorScheme: 'light' }); await scan(`${label} light`, p); await p.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`, p); await p.emulateMedia({ colorScheme: 'light' }); };
// Windows added lately: Recently deleted (events, groups, rooms) with Delete forever, Deleted tasks, hidden lists,
// your own form templates, group menus, Admin → Groups import/export.
const day = 864e5;
const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
await step('Calendar: Recently deleted events, and the Delete forever question', async () => {
  for (const title of ['Gym', 'Yoga']) { const ev = (await api(page, 'POST', '/events', { title, start: dayStart + day + 10 * 36e5, end: dayStart + day + 11 * 36e5 })).body; await api(page, 'DELETE', `/events/${ev.id}`); }
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  const d = page.getByRole('dialog', { name: 'Recently deleted events' });
  await d.getByText('Gym').waitFor();
  await both('Recently deleted events');
  await d.getByLabel('Select Gym').check();
  await d.getByRole('button', { name: 'Delete forever' }).click();
  await page.getByRole('dialog', { name: 'Delete 1 for good?' }).waitFor();
  await both('Delete forever question');
  await page.keyboard.press('Escape');
});
await step('Tasks: Hidden lists open, and Deleted tasks with its boxes', async () => {
  await api(page, 'GET', '/tasks/lists'); // (your first list, "My tasks", is made; that one can't be hidden)
  const lid = (await api(page, 'POST', '/tasks/lists', { name: 'Old project' })).body.id;
  for (const title of ['One', 'Two']) { const t = (await api(page, 'POST', `/tasks/lists/${lid}/tasks`, { title })).body; await api(page, 'DELETE', `/tasks/tasks/${t.id}`); }
  await api(page, 'PUT', `/tasks/lists/${lid}/hidden`, { hidden: true });
  await page.goto(`${B}/tasks/${lid}`);
  await page.getByRole('button', { name: /^Hidden lists/ }).click();
  await page.getByRole('group', { name: 'Hidden lists' }).waitFor();
  await both('Tasks with hidden lists');
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Deleted tasks…' }).click();
  await page.getByRole('dialog', { name: 'Deleted tasks · Old project' }).getByLabel('Select deleted task: One').waitFor();
  await both('Deleted tasks');
  await page.keyboard.press('Escape');
});
await step('Forms: the gallery with a template of your own', async () => {
  const f = (await api(page, 'POST', '/forms', { title: 'Site visit' })).body;
  await api(page, 'PUT', `/forms/${f.id}/my-template`, { template: true });
  await page.goto(`${B}/forms`);
  await page.getByRole('button', { name: 'Start from your template Site visit' }).waitFor();
  await both('Forms gallery with your template');
});
await step('Contacts: a group’s Download and Move menus, and Recently deleted groups', async () => {
  for (const name of ['Board', 'Crew']) await api(page, 'POST', '/contacts/groups', { name, members: [{ email: `${name.toLowerCase()}@example.org` }] });
  const gone = (await api(page, 'POST', '/contacts/groups', { name: 'Old club' })).body;
  await api(page, 'DELETE', `/contacts/groups/${gone.id}`);
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Groups', exact: true }).click();
  await page.getByRole('button', { name: 'Download Board' }).click();
  await page.getByRole('menuitem', { name: /vCard/ }).waitFor();
  await both('Group download menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  await page.getByRole('dialog', { name: 'Recently deleted groups' }).getByText('Old club').waitFor();
  await both('Recently deleted groups');
  await page.keyboard.press('Escape');
});
await step('Admin: Groups with Import and Export, and Recently removed rooms', async () => {
  await api(page, 'POST', '/groups', { name: 'Marketing' });
  const room = (await api(page, 'POST', '/rooms', { name: 'Attic' })).body;
  await api(page, 'DELETE', `/rooms/${room.id}`);
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('link', { name: 'Export as CSV' }).waitFor();
  await both('Admin groups');
  await page.getByRole('tab', { name: 'Company settings' }).click();
  await page.getByRole('button', { name: 'Recently removed' }).click();
  await page.getByRole('dialog', { name: 'Recently removed rooms' }).getByText('Attic').waitFor();
  await both('Recently removed rooms');
  await page.keyboard.press('Escape');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
