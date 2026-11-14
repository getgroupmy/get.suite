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
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

// Every request a screen makes when it opens should work: collect the ones that fail.
const bad = [];
let where = '';
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/') && r.status() >= 400) bad.push(`${where}: ${r.request().method()} ${u.pathname}${u.search} → ${r.status()}`);
});
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) bad.push(`${where}: console: ${m.text().slice(0, 120)}`); });
const visit = async (path, label) => { where = label; await page.goto(`${B}${path}`); await page.waitForTimeout(1500); };

await step('the main screens: nothing fails as they open', async () => {
  for (const [path, label] of [['/home', 'Home'], ['/drive', 'Drive'], ['/drive/shared', 'Shared with me'], ['/drive/sharedbyme', 'Shared by me'], ['/drive/recent', 'Recent'], ['/drive/starred', 'Starred'], ['/drive/trash', 'Trash'], ['/drive/activity', 'Drive activity'], ['/drive/links', 'Shared by link'], ['/drive/drives', 'Shared drives'], ['/drive/approvals', 'Approvals'], ['/drive/signatures', 'Signatures'],
    ['/calendar', 'Calendar'], ['/contacts', 'Contacts'], ['/tasks', 'Tasks'], ['/chat', 'Chat'], ['/notes', 'Notes'], ['/meet', 'Meet'], ['/forms', 'Forms'], ['/settings', 'Settings']]) await visit(path, label);
  if (bad.length) throw new Error(bad.join(' || '));
});
await step('every Admin tab: nothing fails as it opens', async () => {
  bad.length = 0;
  await visit('/admin', 'Admin');
  for (const name of await page.getByRole('tab').allInnerTexts()) {
    where = `Admin ${name}`;
    await page.getByRole('tab', { name, exact: true }).click();
    await page.waitForTimeout(1200);
  }
  if (bad.length) throw new Error(bad.join(' || '));
});

const asOther = async (email, setup) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const mine = [];
  let at = '';
  p.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() >= 400) mine.push(`${at}: ${r.request().method()} ${u.pathname}${u.search} → ${r.status()}`); });
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) mine.push(`${at}: console: ${m.text().slice(0, 120)}`); });
  await p.goto(B);
  await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email);
  await setup(p, (label) => { at = label; });
  return mine;
};
await step('someone who isn’t an admin: nothing fails on the main screens', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const fails = await asOther('kim@acme.com', async (p, label) => {
    for (const [path, l] of [['/home', 'Home'], ['/drive', 'Drive'], ['/drive/shared', 'Shared with me'], ['/drive/sharedbyme', 'Shared by me'], ['/drive/activity', 'Drive activity'], ['/drive/links', 'Shared by link'], ['/calendar', 'Calendar'], ['/contacts', 'Contacts'], ['/tasks', 'Tasks'], ['/chat', 'Chat'], ['/notes', 'Notes'], ['/meet', 'Meet'], ['/forms', 'Forms'], ['/settings', 'Settings']]) {
      label(`Kim ${l}`); await p.goto(`${B}${path}`); await p.waitForTimeout(1200);
    }
  });
  if (fails.length) throw new Error(fails.join(' || '));
});
await step('an admin of another company (not the platform owner): every Admin tab', async () => {
  const r = await api(page, 'POST', '/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gil Green', admin_local: 'gil', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const fails = await asOther('gil@globex.com', async (p, label) => {
    label('Gil Admin'); await p.goto(`${B}/admin`); await p.waitForTimeout(1200);
    for (const name of await p.getByRole('tab').allInnerTexts()) {
      label(`Gil Admin ${name}`);
      await p.getByRole('tab', { name, exact: true }).click();
      await p.waitForTimeout(1200);
    }
  });
  if (fails.length) throw new Error(fails.join(' || '));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
