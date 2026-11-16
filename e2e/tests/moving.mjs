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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
await step('someone brings in a Google Takeout; another hasn’t started', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  const kp = await (await browser.newContext()).newPage();
  await kp.goto(B);
  await kp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  const z = new JSZip();
  z.file('Takeout/Contacts/All Contacts/All Contacts.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Zed\r\nEMAIL:zed@example.com\r\nEND:VCARD\r\n');
  z.file('Takeout/Drive/plan.txt', 'x');
  const b64 = (await z.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const st = await kp.evaluate(async (b) => (await fetch('/api/takeout/restore?tz=UTC', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/zip' }, body: Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) })).status, b64);
  if (st !== 200) throw new Error(`restore ${st}`);
  await kp.context().close();
});
await step('Admin → Moving here shows who has brought what over, and who hasn’t started', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Moving here' }).or(page.getByRole('button', { name: 'Moving here' })).first().click();
  const table = page.getByRole('table', { name: 'People' });
  await table.getByRole('row', { name: /Kim Park/ }).getByText('From Google: 1 file, 1 contact').waitFor();
  await table.getByRole('row', { name: /Lee Chan/ }).getByText('Not started').waitFor();
  await page.getByRole('list', { name: 'So far' }).getByText(/brought in an export/).waitFor();
  await page.getByLabel('Show').selectOption('nothing');
  await until(async () => (await table.getByRole('row', { name: /Kim Park/ }).count()) === 0);
  await table.getByRole('row', { name: /Lee Chan/ }).waitFor();
  await page.getByLabel('Show').selectOption('all');
  await page.screenshot({ path: `${SP}/shots/moving.png` });
  await axe(page, 'moving here');
});
await step('remind those who haven’t started: they get a notification that opens the steps', async () => {
  await page.getByRole('button', { name: /^Remind those who haven’t started/ }).click();
  const d = page.getByRole('dialog', { name: 'Remind those who haven’t started' });
  await d.getByLabel('A note from you (optional)').fill('Please bring your mail over by Friday');
  await d.getByRole('button', { name: 'Send reminder' }).click();
  await page.getByText(/^Reminded \d+ (person|people)$/).waitFor();
  const lee = await (await browser.newContext()).newPage();
  await lee.goto(B);
  await lee.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lee@acme.com', password: 'password123' }) }));
  await lee.goto(`${B}/home`);
  await lee.getByRole('button', { name: /^Notifications, \d+ new/ }).click();
  await lee.getByRole('dialog', { name: 'Notifications' }).getByText('Bring your mail and files over to Workspace').click();
  await lee.waitForURL(/\/settings#move-here$/);
  await lee.getByRole('region', { name: 'Move here from another service' }).waitFor();
  await until(() => lee.getByRole('region', { name: 'Move here from another service' }).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; }));
  await lee.context().close();
});
await step('on a phone the table scrolls inside itself, nothing slides sideways', async () => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.reload();
  await page.getByRole('tab', { name: 'Moving here' }).or(page.getByRole('button', { name: 'Moving here' })).first().click();
  await page.getByRole('table', { name: 'People' }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('wider than the phone');
  await page.screenshot({ path: `${SP}/shots/moving-phone.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
