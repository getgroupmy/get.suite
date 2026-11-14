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
let doc, kimId;
const iso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
await step('share with Kim until a day next week, from the Share dialog', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Audit pack' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Audit pack' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share “Audit pack”/ });
  await d.getByLabel('Email address').fill('kim@acme.com');
  await d.getByRole('button', { name: 'Add' }).click();
  await d.getByLabel('Access for Kim Park ends').fill(iso(Date.now() + 7 * 864e5));
  await d.getByText(/A date beside someone ends their access/).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Sharing updated').waitFor();
  const s = (await api(page, 'GET', `/files/${doc.id}/shares`)).body[0];
  const end = new Date(s.expires_at);
  if (iso(s.expires_at) !== iso(Date.now() + 7 * 864e5) || end.getHours() !== 23) throw new Error('until ' + end);
});
await step('the dialog shows the day again; clearing it removes the end', async () => {
  await page.getByRole('button', { name: 'Actions for Audit pack' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share “Audit pack”/ });
  const box = d.getByLabel('Access for Kim Park ends');
  await until(async () => (await box.inputValue()) === iso(Date.now() + 7 * 864e5));
  await box.fill('');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Sharing updated').waitFor();
  const s = (await api(page, 'GET', `/files/${doc.id}/shares`)).body[0];
  if (s.expires_at !== null) throw new Error('still ends ' + s.expires_at);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
