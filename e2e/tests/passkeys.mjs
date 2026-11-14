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
// A virtual authenticator (fingerprint/PIN built in) on a page, through the DevTools protocol.
const authenticatorOn = async (p) => {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
};
let mine;
await step('Settings → Passkeys: add one (password first, then the device)', async () => {
  mine = await authenticatorOn(page);
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'Passkeys' });
  await sec.getByRole('button', { name: 'Add a passkey' }).click();
  await sec.getByLabel('Your password').fill('password123');
  await sec.getByLabel('Name it').fill('Test laptop');
  await sec.getByRole('button', { name: 'Continue' }).click();
  await sec.getByRole('list', { name: 'Your passkeys' }).getByText('Test laptop').waitFor();
  const { credentials } = await mine.cdp.send('WebAuthn.getCredentials', { authenticatorId: mine.authenticatorId });
  if (credentials.length !== 1 || !credentials[0].isResidentCredential) throw new Error(JSON.stringify(credentials));
  await sec.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/passkeys-settings.png` });
  await axe(page, 'settings');
});
const signInWith = async (credentials) => {
  const p = await mk('fresh');
  const a = await authenticatorOn(p);
  for (const c of credentials) await a.cdp.send('WebAuthn.addCredential', { authenticatorId: a.authenticatorId, credential: c });
  await p.goto(B);
  await p.getByRole('button', { name: /Use a passkey/ }).click();
  return p;
};
await step('another browser signs in with it: no password, no code', async () => {
  const { credentials } = await mine.cdp.send('WebAuthn.getCredentials', { authenticatorId: mine.authenticatorId });
  const p = await signInWith(credentials);
  await p.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const me = (await api(p, 'GET', '/auth/me')).body.user;
  if (me.username !== 'olivia@acme.com') throw new Error(JSON.stringify(me));
  await p.close();
});
await step('removed, it signs nobody in (and the page says why)', async () => {
  const { credentials } = await mine.cdp.send('WebAuthn.getCredentials', { authenticatorId: mine.authenticatorId });
  const sec = page.getByRole('region', { name: 'Passkeys' });
  await sec.getByRole('button', { name: 'Remove Test laptop' }).click();
  await page.getByRole('dialog', { name: 'Remove this passkey?' }).getByRole('button', { name: 'Remove' }).click();
  await until(async () => !(await sec.getByRole('list', { name: 'Your passkeys' }).count()));
  const p = await signInWith(credentials);
  await p.getByRole('alert').getByText(/isn’t on any account here/).waitFor();
  await p.screenshot({ path: `${SP}/shots/passkeys-login.png` });
  await axe(p, 'sign-in page');
  await p.close();
});
await step('a company that requires two steps: after the password, the passkey is the second step', async () => {
  const sec = page.getByRole('region', { name: 'Passkeys' });
  await sec.getByRole('button', { name: 'Add a passkey' }).click();
  await sec.getByLabel('Your password').fill('password123');
  await sec.getByLabel('Name it').fill('Desk key');
  await sec.getByRole('button', { name: 'Continue' }).click();
  await sec.getByRole('list', { name: 'Your passkeys' }).getByText('Desk key').waitFor();
  const r = await api(page, 'PATCH', '/orgs/current', { require_2fa: true });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  const { credentials } = await mine.cdp.send('WebAuthn.getCredentials', { authenticatorId: mine.authenticatorId });
  const p = await mk('second');
  const a = await authenticatorOn(p);
  for (const c of credentials) await a.cdp.send('WebAuthn.addCredential', { authenticatorId: a.authenticatorId, credential: c });
  await p.goto(B);
  await p.getByLabel('Email address').fill('olivia@acme.com');
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  if ((await api(p, 'GET', '/auth/me')).body.user.needs_two_factor) throw new Error('asked to set up two-step');
  await p.close();
  // Admin → Users shows who has a passkey.
  await page.goto(`${B}/admin`);
  await page.getByText('🔑 Passkey').first().waitFor();
  await api(page, 'PATCH', '/orgs/current', { require_2fa: false });
});
await step('renamed in Settings; the bell says passkeys were added', async () => {
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'Passkeys' });
  await sec.getByRole('button', { name: 'Rename Desk key' }).click();
  const dlg = page.getByRole('dialog', { name: 'Rename passkey' });
  await dlg.getByLabel('Name').fill('Office key');
  await dlg.getByLabel('Name').press('Enter');
  await sec.getByRole('list', { name: 'Your passkeys' }).getByText('Office key').waitFor();
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await page.getByText('A passkey was added to your account: “Desk key”').first().waitFor();
  await page.getByText('A passkey was removed from your account: “Test laptop”').first().waitFor();
  await axe(page, 'bell');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
