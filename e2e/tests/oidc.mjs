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
let app, kim;
await step('Admin → Apps: add an app, its secret shown once', async () => {
  await page.goto(`${B}/admin?tab=apps`);
  await page.getByRole('button', { name: 'Add app' }).click();
  const d = page.getByRole('dialog', { name: 'Add an app' });
  await d.getByLabel(/Name/).fill('Company wiki');
  await d.getByLabel(/Redirect/).fill('https://wiki.example/callback');
  await d.getByRole('button', { name: 'Add app' }).click();
  const s = page.getByRole('dialog', { name: 'Company wiki added' });
  app = { client_id: await s.getByLabel('Client ID').inputValue(), client_secret: await s.getByLabel('Client secret').inputValue() };
  if (!/^ws-/.test(app.client_id) || app.client_secret.length < 30) throw new Error(JSON.stringify(app));
  await page.screenshot({ path: `${SP}/shots/oidc-admin.png` });
  await s.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('table', { name: 'Apps' }).getByText('Company wiki').waitFor();
});
await step('a colleague signs in to the wiki with Workspace: asked once, then straight through', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim');
  let landed = null;
  await kim.route('https://wiki.example/**', (route) => { landed = route.request().url(); route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Wiki</h1>' }); });
  const authorize = `${B}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'https://wiki.example/callback', scope: 'openid profile email', state: 's1' })}`;
  await kim.goto(authorize);
  // Not signed in yet: Workspace asks them to sign in first, then carries on.
  await kim.getByLabel('Email address').fill('kim@acme.com');
  await kim.getByLabel('Password').fill('password123');
  await kim.getByRole('button', { name: 'Sign in' }).click();
  await kim.getByRole('heading', { name: 'Sign in to Company wiki' }).waitFor();
  await kim.getByText('It will see your name and your email address').waitFor();
  await kim.screenshot({ path: `${SP}/shots/oidc-consent.png` });
  await kim.getByRole('button', { name: 'Allow' }).click();
  await until(() => landed);
  const code = new URL(landed).searchParams.get('code');
  if (new URL(landed).searchParams.get('state') !== 's1' || !code) throw new Error(landed);
  const tok = await (await fetch(`${B}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://wiki.example/callback', client_id: app.client_id, client_secret: app.client_secret }) })).json();
  const info = await (await fetch(`${B}/oauth/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  if (info.email !== 'kim@acme.com' || info.name !== 'Kim Park') throw new Error(JSON.stringify(info));
  landed = null;
  await kim.goto(authorize.replace('s1', 's2'));
  await until(() => landed && new URL(landed).searchParams.get('state') === 's2');
});
await step('Settings → Apps you sign in to: remove it, and it asks again', async () => {
  await kim.goto(`${B}/settings`);
  await kim.getByRole('list', { name: 'Apps you sign in to' }).getByText('Company wiki').waitFor();
  await kim.getByRole('button', { name: 'Remove Company wiki' }).click();
  await kim.getByText('Company wiki removed').waitFor();
  await kim.goto(`${B}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'https://wiki.example/callback', scope: 'openid email', state: 's3' })}`);
  await kim.getByRole('heading', { name: 'Sign in to Company wiki' }).waitFor();
});
await step('Edit: only the Ops group may use it; Kim is told she can\'t', async () => {
  await api(page, 'POST', '/groups', { name: 'Ops' });
  await page.goto(`${B}/admin?tab=apps`);
  await page.getByRole('button', { name: 'Edit Company wiki' }).click();
  const d = page.getByRole('dialog', { name: 'Edit Company wiki' });
  await d.getByLabel('Only people in these groups').check();
  await d.getByLabel('Ops').check();
  await page.screenshot({ path: `${SP}/shots/oidc-groups.png` });
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('table', { name: 'Apps' }).getByText('Ops', { exact: true }).waitFor();
  await kim.goto(`${B}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'https://wiki.example/callback', scope: 'openid email', state: 's4' })}`);
  await kim.getByText(/allowed to use Company wiki/).waitFor();
});
await step('an app with an address shows under Company apps on Home, for those who may use it', async () => {
  await page.goto(`${B}/admin?tab=apps`);
  await page.getByRole('button', { name: 'Edit Company wiki' }).click();
  const d = page.getByRole('dialog', { name: 'Edit Company wiki' });
  await d.getByLabel(/The app's address/).fill('https://wiki.example/');
  await d.getByLabel('Everyone in the company').check();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('App saved').waitFor();
  await kim.goto(`${B}/home`);
  const card = kim.getByRole('region', { name: 'Company apps' });
  await card.getByRole('link', { name: /Company wiki/ }).waitFor();
  if ((await card.getByRole('link', { name: /Company wiki/ }).getAttribute('href')) !== 'https://wiki.example/') throw new Error('href');
  await kim.screenshot({ path: `${SP}/shots/home-apps.png` });
});
await step('the app signs Kim out: Workspace asks, then she\'s signed out and back at the app', async () => {
  let landed = null;
  await kim.route('https://wiki.example/**', (route) => { landed = route.request().url(); route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Bye</h1>' }); });
  await kim.goto(`${B}/oauth/logout?${new URLSearchParams({ client_id: app.client_id, post_logout_redirect_uri: 'https://wiki.example/bye' })}`);
  await kim.getByRole('heading', { name: 'Sign out of Workspace?' }).waitFor();
  await kim.getByText('Company wiki signed you out.').waitFor();
  await kim.getByRole('button', { name: 'Sign out', exact: true }).click();
  await until(() => landed === 'https://wiki.example/bye');
  const me = (await kim.request.get(`${B}/api/auth/me`)).status();
  if (me !== 401) throw new Error('still signed in: ' + me);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
