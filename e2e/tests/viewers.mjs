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
let kim, doc;
await step('Kim opens a shared document', async () => {
  const kid = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Price list' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kid, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.locator('.ProseMirror').waitFor();
});
await step('Details shows who has seen it (not you)', async () => {
  await page.goto(`${B}/docs/${doc.id}`); // you opened it too
  await page.locator('.ProseMirror').waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Price list' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const seen = page.getByRole('region', { name: 'Who has seen it' });
  await seen.getByText('Kim Park').waitFor();
  if (await seen.getByText('Olivia Owner').count()) throw new Error('you are not listed');
});
await step('Kim, a viewer, does not see the list', async () => {
  await kim.goto(`${B}/drive/shared`);
  await kim.getByRole('button', { name: 'Actions for Price list' }).click();
  await kim.getByRole('menuitem', { name: 'Details' }).click();
  await kim.getByRole('dialog', { name: 'Details' }).getByText('Type').waitFor();
  if (await kim.getByRole('region', { name: 'Who has seen it' }).count()) throw new Error('viewers should not see it');
});
await step('Kim hides her openings in Settings; the company can turn it off', async () => {
  await kim.goto(`${B}/settings`);
  await kim.getByLabel("Show the owners and editors of files when I've opened them").uncheck();
  await kim.getByText(/Your openings are hidden/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Actions for Price list' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await page.getByRole('region', { name: 'Who has seen it' }).getByText('Nobody has opened it yet.').waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: /Company settings/ }).or(page.getByRole('button', { name: /Company settings/ })).first().click();
  await page.getByLabel(/Show owners and editors who has opened their files/).uncheck();
  await page.getByText('Nobody sees who has opened files').waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Price list' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await page.getByRole('dialog', { name: 'Details' }).getByText('Type').waitFor();
  await page.waitForTimeout(500);
  if (await page.getByRole('region', { name: 'Who has seen it' }).count()) throw new Error('turned off');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
