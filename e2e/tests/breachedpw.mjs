import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
// e2e-env: PWNED_PASSWORDS_URL=http://127.0.0.1:8198/range/
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
// A stand-in for Have I Been Pwned's password list: "Summer2024!!" has been in 52,104 breaches.
const http = await import('node:http');
const crypto = await import('node:crypto');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();
const LEAKED = 'Summer2024!!';
const asked = [];
const pwned = http.createServer((req, res) => {
  asked.push(req.url);
  const prefix = req.url.split('/').pop();
  res.end(['00000000000000000000000000000000000:0', ...(sha(LEAKED).startsWith(prefix) ? [`${sha(LEAKED).slice(5)}:52104`] : [])].join('\r\n'));
});
await new Promise((r) => pwned.listen(8198, '127.0.0.1', r));

await step('Admin → Company settings: “Not one known from data breaches”', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const box = page.getByRole('checkbox', { name: 'Not one known from data breaches' });
  await box.check();
  await page.getByText('Password rules saved').waitFor();
  await page.getByText(/Only the first 5 characters of a scrambled form/).waitFor();
  await axe(page, 'password rules');
  await page.reload();
  if (!(await page.getByRole('checkbox', { name: 'Not one known from data breaches' }).isChecked())) throw new Error('not kept');
});
await step('changing your password to a breached one is refused, with how often it leaked; another is fine', async () => {
  await page.goto(`${B}/settings`);
  const form = page.getByRole('form', { name: 'Change password' });
  await form.getByText(/not one known from data breaches/).waitFor();
  await form.getByLabel('Current password').fill('password123');
  await form.getByLabel('New password', { exact: true }).fill(LEAKED);
  await form.getByLabel('Confirm new password').fill(LEAKED);
  await form.getByRole('button', { name: 'Change password' }).click();
  await form.getByText('That password has turned up in data breaches 52,104 times, so attackers try it first. Choose another').waitFor();
  if (asked.length !== 1 || asked[0] !== `/range/${sha(LEAKED).slice(0, 5)}`) throw new Error(`asked ${asked}`);
  await page.screenshot({ path: `${SP}/shots/breached.png` });
  await form.getByLabel('New password', { exact: true }).fill('copper-lantern-58');
  await form.getByLabel('Confirm new password').fill('copper-lantern-58');
  await form.getByRole('button', { name: 'Change password' }).click();
  await page.getByText(/Password changed|Password updated/).first().waitFor();
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
pwned.close();
await browser.close();
process.exit(failed ? 1 : 0);
