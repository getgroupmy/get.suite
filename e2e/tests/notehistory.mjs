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
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (p, t) => p.locator('.chip', { hasText: t });
let kim, lee;
const cardOf = (p, name) => p.getByRole('article', { name, exact: true });
let note;
await step('setup: Olivia shares a note with Kim, who changes it', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  note = (await api(page, 'POST', '/notes', { title: 'Office move', body: 'Desks on Friday\nPhones on Monday' })).body;
  await api(page, 'PUT', `/notes/${note.id}/shares`, { user_ids: [kimId] });
  await api(kim, 'PATCH', `/notes/${note.id}`, { body: 'Everything on Friday' });
});
await step('Version history shows what Olivia had, with her name; Restore puts it back', async () => {
  await page.goto(`${B}/notes`);
  await cardOf(page, 'Office move').getByText('Everything on Friday').waitFor();
  await cardOf(page, 'Office move').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const d = page.getByRole('dialog', { name: 'Version history: Office move' });
  await d.getByRole('list', { name: 'Versions' }).getByText('Olivia Owner').waitFor();
  await d.getByRole('article', { name: 'This version' }).getByText(/Desks on Friday/).waitFor();
  await page.screenshot({ path: `${SP}/shots/notehistory.png` });
  await d.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByText('Earlier version restored').waitFor();
  await cardOf(page, 'Office move').getByText(/Desks on Friday/).waitFor();
  await until(async () => (await api(kim, 'GET', '/notes')).body.find((n) => n.id === note.id)?.body.startsWith('Desks'));
});
await step('Kim sees his own text kept in the history too', async () => {
  const versions = (await api(kim, 'GET', `/notes/${note.id}/versions`)).body;
  if (versions[0]?.body !== 'Everything on Friday' || versions[0]?.saved_by !== 'Kim Park') throw new Error(JSON.stringify(versions));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
