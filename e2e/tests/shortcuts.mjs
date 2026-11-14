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
let report, reading, projects, sam;
await step('Sam adds a shortcut to a shared document into a folder of his', async () => {
  const id = (await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam Short', password: 'password123' })).body.id;
  projects = (await api(page, 'POST', '/files/folder', { name: 'Projects' })).body;
  report = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Annual report', parent_id: projects.id })).body;
  await api(page, 'PUT', `/files/${report.id}/shares`, { shares: [{ user_id: id, role: 'editor' }] });
  sam = await mk('sam'); await signIn(sam, 'sam@acme.com');
  reading = (await api(sam, 'POST', '/files/folder', { name: 'Reading' })).body;
  await sam.goto(`${B}/drive/shared`);
  await sam.getByRole('button', { name: 'Actions for Annual report' }).click();
  await sam.getByRole('menuitem', { name: 'Add shortcut to Drive…' }).click();
  const d = sam.getByRole('dialog', { name: 'Add a shortcut to “Annual report”' });
  await d.getByRole('button', { name: 'Reading' }).click();
  await d.getByRole('button', { name: 'Add shortcut here' }).click();
  await sam.getByText('Shortcut added').waitFor();
  await sam.goto(`${B}/drive/folder/${reading.id}`);
  await sam.getByRole('button', { name: 'Actions for Annual report (shortcut)' }).waitFor();
  if (await sam.getByRole('checkbox', { name: 'Select Annual report' }).count()) throw new Error('shortcut can be picked');
});
await step('opening the shortcut opens the document; its location is where it really is', async () => {
  await sam.getByText('Annual report').dblclick();
  await sam.waitForURL(new RegExp(`/docs/${report.id}`));
  await sam.goBack();
  await sam.getByRole('button', { name: 'Actions for Annual report (shortcut)' }).click();
  await sam.getByRole('menuitem', { name: 'Show file location' }).click();
  await sam.waitForURL(/\/drive\/shared/); // Sam can't open the Projects folder itself
  // Olivia's own shortcut leads to the folder it's in.
  await api(page, 'POST', `/files/${report.id}/shortcut`, {});
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Annual report (shortcut)' }).click();
  await page.getByRole('menuitem', { name: 'Show file location' }).click();
  await page.waitForURL(new RegExp(`/drive/folder/${projects.id}`));
  await page.getByRole('button', { name: 'Actions for Annual report', exact: true }).waitFor();
}, sam);
await step('a shortcut to something no longer shared shows as such, and can be removed', async () => {
  await api(page, 'PUT', `/files/${report.id}/shares`, { shares: [] });
  await sam.goto(`${B}/drive/folder/${reading.id}`);
  await sam.getByText('Shortcut to something you can no longer open').waitFor();
  await sam.getByRole('button', { name: /Actions for Shortcut to something/ }).click();
  await sam.getByRole('menuitem', { name: 'Remove shortcut' }).click();
  await sam.getByText('Shortcut removed (the file itself is still there)').waitFor();
  await until(async () => (await api(sam, 'GET', `/files?view=mine&parent=${reading.id}`)).body.length === 0);
  if ((await api(page, 'GET', `/files/${report.id}`)).status !== 200) throw new Error('file gone');
}, sam);
await step('moving files offers real folders only', async () => {
  await api(page, 'POST', `/files/${projects.id}/shortcut`, {});
  const other = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Loose note' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Loose note' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const d = page.getByRole('dialog', { name: 'Move “Loose note”' });
  await d.getByRole('button', { name: 'Projects' }).waitFor();
  if (await d.getByRole('button', { name: 'Projects' }).count() !== 1) throw new Error('shortcut listed as a folder');
  if (!other.id) throw new Error('no file');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
