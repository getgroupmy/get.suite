import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let kim;
const sendAs = async (username, to, subject) => {
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async (u) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) }), username);
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to, subject, text: 'Hello.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
};
const open = async (subject) => {
  await kim.locator('.mail-list').getByText(subject, { exact: true }).waitFor({ timeout: 30000 });
  await kim.locator('.mail-list').getByText(subject, { exact: true }).click();
  await kim.locator('.mail-reader').getByText(subject).first().waitFor();
};
await step('setup: Kim at Acme; Globex outside, where someone calls themselves Olivia Owner', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const g = await browser.newContext(); const gp = await g.newPage(); await gp.goto(B);
  await gp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gina@globex.com', password: 'password123' }) }));
  const u = await api(gp, 'POST', '/users', { local: 'boss', domain: 'globex.com', name: 'Olivia Owner', password: 'password123' });
  if (u.status !== 201) throw new Error(JSON.stringify(u.body));
  await g.close();
  await sendAs('gina@globex.com', 'kim@acme.com', 'Shipping quote');
  await sendAs('boss@globex.com', 'kim@acme.com', 'Urgent wire transfer');
  await sendAs('olivia@acme.com', 'kim@acme.com', 'Team lunch');
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  kim = await kctx.newPage();
  kim.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(kim, 'kim@acme.com');
});
await step('setting off: plain outside mail has no note, but a colleague’s name from outside is warned about', async () => {
  await open('Shipping quote');
  if (await kim.locator('.mail-reader .banner.outside, .mail-reader .banner.danger').count()) throw new Error('marked while off');
  await open('Urgent wire transfer');
  await kim.locator('.mail-reader .banner.danger').getByText('this may be someone pretending to be Olivia Owner').waitFor();
  await kim.locator('.mail-reader .banner.danger').getByText(/boss@globex\.com/).waitFor();
  await kim.screenshot({ path: `${SP}/shots/outside-lookalike.png` });
  await axe(kim, 'lookalike');
  await open('Team lunch');
  if (await kim.locator('.mail-reader .banner.outside, .mail-reader .banner.danger').count()) throw new Error('a colleague marked');
});
await step('an admin turns on Mark email from outside the company: outside mail gets the note', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  await page.getByLabel('Mark email from outside the company').check();
  await page.getByText('Mail from outside the company now shows a warning').waitFor();
  await open('Shipping quote');
  await kim.locator('.mail-reader .banner.outside').getByText('From outside Acme Trading (gina@globex.com)').waitFor();
  await axe(kim, 'outside');
  await open('Team lunch');
  if (await kim.locator('.mail-reader .banner.outside').count()) throw new Error('a colleague marked');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
