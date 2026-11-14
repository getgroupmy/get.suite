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
const { DatabaseSync } = await import('node:sqlite');

await step('Admin → Activity says newer actions in words: recovery email, passkeys, a phishing report', async () => {
  for (const email of ['olivia.home@example.net', null]) {
    const r = await api(page, 'PUT', '/auth/recovery-email', { password: 'password123', email });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
  }
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  // Ones that need a security key or a mail server: recorded straight into the log.
  const db = new DatabaseSync(`${SP}/data/workspace.db`);
  const add = db.prepare('INSERT INTO audit_log (org_id, at, actor_id, actor_name, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)');
  add.run(me.org_id, Date.now(), me.id, me.name, 'passkey.added', 'Work laptop', '127.0.0.1');
  add.run(me.org_id, Date.now(), me.id, me.name, 'mail.phishing', 'payroll@evilpay.com', '127.0.0.1');
  db.close();
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Activity' }).or(page.getByRole('button', { name: 'Activity' })).first().click();
  const table = page.locator('table.activity');
  for (const t of ['Reported a phishing email', 'Added a passkey', 'Removed their recovery email', 'Set a recovery email']) await table.getByText(t, { exact: true }).waitFor();
  const text = await table.innerText();
  const code = text.match(/\b(passkey|mail|recovery|dlp)\.[a-z_]+\b/);
  if (code) throw new Error(`a raw code on screen: ${code[0]}`);
  // A phishing report stands out.
  await table.locator('.pill.warn', { hasText: 'Reported a phishing email' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/activity-words.png` });
  await axe(page, 'activity');
});

await step('the filters find them: Sign-ins and security, Phishing and data protection', async () => {
  const table = page.locator('table.activity');
  await page.getByLabel('Kind of activity').selectOption({ label: 'Sign-ins and security' });
  await until(async () => !(await table.getByText('Reported a phishing email').count()));
  for (const t of ['Added a passkey', 'Set a recovery email', 'Removed their recovery email']) await table.getByText(t, { exact: true }).waitFor();
  await page.getByLabel('Kind of activity').selectOption({ label: 'Phishing and data protection' });
  await until(async () => !(await table.getByText('Added a passkey').count()));
  await table.getByText('Reported a phishing email', { exact: true }).waitFor();
  await table.getByText('payroll@evilpay.com').waitFor();
  if ((await table.locator('tbody tr').count()) !== 1) throw new Error(`rows: ${await table.locator('tbody tr').count()}`);
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
