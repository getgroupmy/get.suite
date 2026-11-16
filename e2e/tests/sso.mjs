import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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

// A stand-in identity provider (OpenID Connect), already signed in: /authorize sends the person straight back
// with a code, for whoever the sign-in hint names.
const http = await import('node:http');
const crypto = await import('node:crypto');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const codes = new Map();
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signJwt = (claims) => { const h = enc({ alg: 'RS256', kid: 'k1' }), b = enc(claims); return `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), key.privateKey).toString('base64url')}`; };
let issuer;
const idp = http.createServer((req, res) => {
  const u = new URL(req.url, issuer);
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  if (u.pathname === '/jwks') return json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] });
  if (u.pathname === '/authorize') {
    const code = crypto.randomBytes(12).toString('hex');
    codes.set(code, { email: u.searchParams.get('login_hint'), nonce: u.searchParams.get('nonce'), aud: u.searchParams.get('client_id') });
    res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
    return res.end();
  }
  if (u.pathname === '/token') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const c = codes.get(new URLSearchParams(body).get('code'));
      if (!c) return json({ error: 'invalid_grant' }, 400);
      json({ id_token: signJwt({ iss: issuer, aud: c.aud, exp: Math.floor(Date.now() / 1000) + 300, nonce: c.nonce, email: c.email }) });
    });
    return undefined;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => idp.listen(0, '127.0.0.1', r));
issuer = `http://127.0.0.1:${idp.address().port}`;

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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
});
await step('Admin → Company settings: single sign-on set up (the secret isn’t shown again)', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const f = page.locator('form.sso-settings');
  await f.getByLabel('Sign-in (redirect) address to give the provider').waitFor();
  if (!(await f.getByLabel('Sign-in (redirect) address to give the provider').inputValue()).endsWith('/api/auth/sso/callback')) throw new Error('callback');
  await f.getByLabel('Name on the sign-in page').fill('Microsoft');
  await f.getByLabel('Issuer address').fill(issuer);
  await f.getByLabel('Client ID').fill('ws-app');
  await f.getByLabel(/Client secret/).fill('shh');
  await f.getByRole('button', { name: 'Save' }).click();
  await page.getByText('People can sign in with Microsoft').waitFor();
  await f.getByText('On', { exact: true }).waitFor();
  await axe(page, 'sso settings');
  await page.reload();
  await page.locator('form.sso-settings').getByText('(saved: type a new one to change it)').waitFor();
  if (await page.locator('form.sso-settings').getByLabel(/Client secret/).inputValue()) throw new Error('secret shown');
});
const kim = await mk('kim');
await step('Kim types her address: “Sign in with Microsoft”; the provider says yes and she’s in', async () => {
  await kim.goto(B);
  await kim.getByLabel('Email address').fill('kim@acme.com');
  await kim.getByRole('link', { name: 'Sign in with Microsoft' }).click();
  await kim.getByRole('link', { name: 'Drive', exact: true }).first().waitFor({ timeout: 15000 });
  const me = await api(kim, 'GET', '/auth/me');
  if (me.body.user.username !== 'kim@acme.com') throw new Error(JSON.stringify(me.body));
  await kim.screenshot({ path: `${SP}/shots/sso-in.png` });
}, kim);
await step('a mail-app password without knowing her password: confirm with Microsoft, back to Settings, made', async () => {
  await kim.goto(`${B}/settings`);
  const sec = kim.locator('section', { has: kim.getByRole('heading', { name: /on your phone/ }) });
  await sec.getByRole('button', { name: 'Create mail-app password' }).click();
  await sec.getByText('(or leave it empty if you just confirmed with Microsoft)').waitFor();
  await sec.getByRole('link', { name: 'Confirm with Microsoft' }).click();
  await kim.waitForURL(/\/settings$/, { timeout: 15000 });
  const sec2 = kim.locator('section', { has: kim.getByRole('heading', { name: /on your phone/ }) });
  await sec2.getByRole('button', { name: 'Create mail-app password' }).last().click();
  await sec2.getByLabel('Mail-app password').waitFor();
  if (!/^[a-z]{4}(-[a-z]{4}){3}$/.test((await sec2.getByLabel('Mail-app password').innerText()).trim())) throw new Error('not shown');
  await axe(kim, 'mail-app password via sso');
}, kim);
await step('an address with no account here: back on the sign-in page, saying why', async () => {
  const p = await mk('nobody');
  await p.goto(B);
  await p.getByLabel('Email address').fill('nobody@acme.com');
  await p.getByRole('link', { name: 'Sign in with Microsoft' }).click();
  await p.getByRole('alert').getByText('nobody@acme.com has no Workspace account here. Ask your admin.').waitFor();
  if (/sso_error/.test(p.url())) throw new Error('error left in the address');
  await p.getByLabel('Email address').fill('someone@elsewhere.com');
  await p.waitForTimeout(600);
  if (await p.getByRole('link', { name: /Sign in with/ }).count()) throw new Error('offered for another domain');
  await axe(p, 'sign-in error');
}, kim);
await step('required: Kim’s password is refused, pointing to Microsoft; the page says so; the admin still has hers', async () => {
  await page.goto(`${B}/admin?tab=company`);
  await page.locator('form.sso-settings').getByRole('checkbox', { name: /Require it/ }).check();
  await page.getByText('Everyone but admins now signs in with single sign-on').waitFor();
  const p = await mk('kim2');
  await p.goto(B);
  await p.getByLabel('Email address').fill('kim@acme.com');
  await p.getByRole('note').getByText('Your company signs in with Microsoft. (Admins can still use their password.)').waitFor();
  await p.getByLabel('Password', { exact: true }).fill('password123');
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await p.getByRole('alert').getByText('Your company signs in with Microsoft: use “Sign in with Microsoft”.').waitFor();
  await axe(p, 'sso required');
  const admin = await api(p, 'POST', '/auth/login', { username: 'olivia@acme.com', password: 'password123' });
  if (admin.status !== 200) throw new Error(JSON.stringify(admin));
}, kim);
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
idp.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
