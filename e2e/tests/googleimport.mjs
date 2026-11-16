// e2e-env: GOOGLE_AUTH_URL=http://127.0.0.1:8189/auth GOOGLE_TOKEN_URL=http://127.0.0.1:8189/token GOOGLE_IMAP_HOST=127.0.0.1
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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
// A stand-in for Google: its sign-in page says yes at once and sends the person back; its token service gives access.
const http = await import('node:http');
const seen = { auth: null, token: null };
const g = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/auth') {
    seen.auth = Object.fromEntries(u.searchParams);
    const back = new URL(seen.auth.redirect_uri);
    back.searchParams.set('code', 'good-code'); back.searchParams.set('state', seen.auth.state);
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.token = Object.fromEntries(new URLSearchParams(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: 'ya29.fake', scope: 'openid email https://mail.google.com/', id_token: `x.${Buffer.from(JSON.stringify({ email: 'ana@gmail.com', email_verified: true })).toString('base64url')}.y` }));
  });
});
await new Promise((r) => g.listen(8189, '127.0.0.1', r));
await step('an admin gives the company’s Google client (the secret isn’t shown back)', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const card = page.locator('form', { has: page.getByRole('heading', { name: 'Importing mail from Gmail and Google Workspace' }) });
  await card.getByText(`${B}/api/mail/import/google/callback`).waitFor();
  await card.getByLabel('Client ID').fill('1234-abc.apps.googleusercontent.com');
  await card.getByLabel(/^Client secret/).fill('GOCSPX-test-secret-1');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByText('People can now import mail from Google').waitFor();
  await card.getByLabel('Client secret (set: type a new one to replace it)').waitFor();
  const org = (await api(page, 'GET', '/orgs/current')).body;
  if (JSON.stringify(org).includes('GOCSPX-test-secret-1') || !org.g_has_secret) throw new Error('secret sent back, or not kept');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/googleimport-admin.png` });
  await axe(page, 'google admin');
});
await step('Import mail → Gmail: off to Google and back, then the import runs with the access Google gave', async () => {
  await page.goto(`${B}/mail?import=1&from=imap.gmail.com`);
  const d = page.getByRole('dialog', { name: 'Import mail' });
  const form = d.getByRole('form', { name: 'Import from Google' });
  await form.getByRole('button', { name: 'Sign in with Google' }).waitFor();
  if (await d.getByLabel('Your password there').count()) throw new Error('asked for a password');
  await form.getByLabel('Your Google address (optional)').fill('ana@gmail.com');
  await axe(page, 'google import');
  await form.getByRole('button', { name: 'Sign in with Google' }).click();
  // Back in Workspace (the test mail server here can't take Google's sign-in, so the import says so).
  await page.getByRole('dialog', { name: 'Import mail' }).getByText(/didn’t accept the sign-in/).first().waitFor({ timeout: 30000 });
  if (seen.auth.login_hint !== 'ana@gmail.com' || seen.auth.code_challenge_method !== 'S256' || !seen.auth.scope.includes('https://mail.google.com/')) throw new Error(JSON.stringify(seen.auth));
  if (seen.token.code !== 'good-code' || seen.token.client_secret !== 'GOCSPX-test-secret-1' || !seen.token.code_verifier) throw new Error(JSON.stringify(seen.token));
});
await step('without the company’s client, Gmail asks for an app password as before', async () => {
  await api(page, 'PATCH', '/orgs/current', { g_client_id: '' });
  await page.goto(`${B}/mail?import=1&from=imap.gmail.com`);
  await page.getByRole('dialog', { name: 'Import mail' }).getByLabel('Your password there').waitFor();
});
g.close();
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
