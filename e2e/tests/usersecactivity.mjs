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

await step('Admin → Users → Signed-in devices also shows their recent security activity', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const guess = await mk('stranger');
  await guess.goto(B);
  for (const pw of ['letmein-1', 'letmein-2', 'letmein-3']) await api(guess, 'POST', '/auth/login', { username: 'kim@acme.com', password: pw });
  await guess.context().close();
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await page.goto(`${B}/admin`);
  await page.getByRole('button', { name: 'Actions for Kim Park' }).click();
  await page.getByRole('menuitem', { name: 'Signed-in devices' }).click();
  const d = page.getByRole('dialog', { name: "Kim Park's signed-in devices" });
  const act = d.getByRole('region', { name: 'Recent security activity' });
  await act.getByRole('status').getByText('3 failed sign-in attempts in the last 30 days').waitFor();
  const list = act.getByRole('list', { name: 'Recent security activity' });
  await list.locator('li').first().waitFor();
  const first = await list.locator('li').allInnerTexts();
  if (!/^Signed in\n/.test(first[0]) || first.filter((t) => t.startsWith('Failed sign-in: wrong password')).length !== 3) throw new Error(first.join(' | '));
  if (first.some((t) => /\byou\b/i.test(t))) throw new Error('worded to the admin as “you”');
  await list.locator('li').nth(1).locator('.pill.warn').waitFor();
  await page.screenshot({ path: `${SP}/shots/user-security-activity.png` });
  await axe(page, 'user activity');
  // Signing Kim out shows up there straight away.
  await d.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('Signed out that device').waitFor();
  await list.locator('li').first().getByText('1 device was signed out').waitFor();
  await list.locator('li').first().getByText(/by Olivia Owner/).waitFor();
});

await step('someone who isn’t an admin can’t look', async () => {
  const lee = await mk('lee');
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  await signIn(lee, 'lee@acme.com');
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  const r = await api(lee, 'GET', `/users/${me.id}/security-activity`);
  if (r.status !== 403) throw new Error(JSON.stringify(r));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
