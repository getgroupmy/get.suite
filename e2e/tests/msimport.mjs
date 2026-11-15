// e2e-env: MS_LOGIN_URL=http://127.0.0.1:8188 MS_IMAP_HOST=127.0.0.1
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
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
// A stand-in for login.microsoftonline.com: a code, "still waiting" once, then a token.
const http = await import('node:http');
let polls = 0;
const calls = [];
const ms = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, ...Object.fromEntries(new URLSearchParams(body)) });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/devicecode')) return res.end(JSON.stringify({ device_code: 'DEV', user_code: 'WXYZ-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 }));
    if (++polls < 3) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'authorization_pending' })); }
    res.end(JSON.stringify({ access_token: 'AT-fake', token_type: 'Bearer', expires_in: 3600 }));
  });
});
await new Promise((r) => ms.listen(8188, '127.0.0.1', r));
await step('an admin gives the company’s Microsoft app', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const card = page.getByRole('form', { name: 'Importing from Microsoft 365' }).or(page.locator('form', { has: page.getByRole('heading', { name: 'Importing from Microsoft 365' }) })).first();
  await card.getByLabel('Application (client) ID').fill('not-a-guid');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/looks like 00000000/).waitFor();
  await card.getByLabel('Application (client) ID').fill('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByText('People can now import mail from Microsoft 365').waitFor();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/msimport-admin.png` });
  await axe(page, 'ms admin');
});
await step('Import mail → Microsoft 365: a code to enter at Microsoft, then the import starts with what Microsoft gives', async () => {
  await page.goto(`${B}/mail?import=1&from=outlook.office365.com`);
  const d = page.getByRole('dialog', { name: 'Import mail' });
  const form = d.getByRole('form', { name: 'Import from Microsoft 365' });
  await form.getByLabel('Your Microsoft 365 address').fill('ana@contoso.com');
  if (await d.getByLabel('Your password there').count()) throw new Error('asked for a password');
  await form.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  await d.getByLabel('Your code').filter({ hasText: 'WXYZ-1234' }).waitFor();
  await d.getByRole('link', { name: 'microsoft.com/devicelogin' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/msimport-code.png` });
  await axe(page, 'ms code');
  // Microsoft gives a token; the import connects with it (the test mail server here can't take Microsoft's
  // sign-in, so it says so: what matters is that it tried, with the token and no password).
  await d.getByText(/didn’t accept|It didn’t work|stopped/).first().waitFor({ timeout: 30000 });
  const tok = calls.find((c) => c.grant_type);
  if (tok?.device_code !== 'DEV' || tok.client_id !== '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0') throw new Error(JSON.stringify(calls));
  if (!calls[0].scope.includes('IMAP.AccessAsUser.All')) throw new Error(calls[0].scope);
});
await step('without the company’s app, Microsoft 365 asks for a password as before', async () => {
  await api(page, 'PATCH', '/orgs/current', { ms_client_id: '' });
  await page.goto(`${B}/mail?import=1&from=outlook.office365.com`);
  await page.getByRole('dialog', { name: 'Import mail' }).getByLabel('Your password there').waitFor();
});
ms.close();
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
