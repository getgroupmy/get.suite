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
await step('Kim reports a phishing email: it goes to Junk', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const r = await api(page, 'POST', '/orgs', { name: 'Evil Payroll', domain: 'evilpay.com', admin_name: 'Mallory', admin_local: 'payroll', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(B);
  await g.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'payroll@evilpay.com', password: 'password123' }) }));
  for (let k = 0; k < 10; k++) { if ((await api(g, 'POST', '/mail/send', { to: 'kim@acme.com', subject: 'Confirm your bank details', text: 'Click here to keep getting paid.' })).status === 200) break; await g.waitForTimeout(1500); }
  await ctx.close();
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  kim = await kctx.newPage();
  kim.on('pageerror', (e) => errors.push(`kim: ${e.message}`));
  await signIn(kim, 'kim@acme.com');
  await kim.locator('.mail-list').getByText('Confirm your bank details', { exact: true }).waitFor({ timeout: 30000 });
  await kim.locator('.mail-list').getByText('Confirm your bank details', { exact: true }).click();
  await kim.locator('.mail-reader').getByRole('button', { name: /Report phishing/ }).click();
  const d = kim.getByRole('dialog', { name: 'Report this email as phishing?' });
  await d.getByText(/Don't click its links/).waitFor();
  await axe(kim, 'confirm');
  await d.getByRole('button', { name: 'Report phishing' }).click();
  await kim.getByText(/Reported as phishing: your admins have been told/).waitFor();
  await until(async () => !(await kim.locator('.mail-list').getByText('Confirm your bank details', { exact: true }).count()));
});
await step('Olivia (an admin) is told, and Admin → Phishing lists the sender; mark it handled', async () => {
  await page.reload();
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await page.getByText('Kim Park reported a phishing email from payroll@evilpay.com').first().waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Phishing' }).or(page.getByRole('button', { name: 'Phishing' })).first().click();
  const sec = page.getByRole('region', { name: 'Phishing reports' });
  await sec.getByText('payroll@evilpay.com').waitFor();
  await sec.getByText('“Confirm your bank details”').waitFor();
  await sec.getByRole('status').getByText('1 sender to look at').waitFor();
  await page.screenshot({ path: `${SP}/shots/phishing-admin.png` });
  await axe(page, 'admin');
  await sec.getByRole('button', { name: 'Mark handled: payroll@evilpay.com' }).click();
  await sec.getByRole('status').getByText('All handled').waitFor();
  await sec.getByText(/Handled by Olivia Owner/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
