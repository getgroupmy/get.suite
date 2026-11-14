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

let kim;
await step('Kim sees her sign-ins, two failed tries and an admin signing her out, in words', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const guess = await mk('stranger');
  await guess.goto(B);
  for (const pw of ['letmein-1', 'letmein-2']) await api(guess, 'POST', '/auth/login', { username: 'kim@acme.com', password: pw });
  await guess.context().close();
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await api(page, 'DELETE', `/users/${r.body.id}/sessions/all`);
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/settings`);
  const sec = kim.getByRole('region', { name: 'Recent security activity' });
  await sec.getByRole('status').getByText('2 failed sign-in attempts in the last 30 days').waitFor();
  const list = sec.getByRole('list', { name: 'Recent security activity' });
  await list.locator('li').first().waitFor();
  const lines = await list.locator('li .device-name').allInnerTexts();
  const want = ['You signed in', '1 device was signed out', 'You signed in', 'Someone tried to sign in as you: wrong password', 'Someone tried to sign in as you: wrong password'];
  if (lines.join('|') !== want.join('|')) throw new Error(lines.join('|'));
  await list.locator('li', { hasText: 'device was signed out' }).getByText(/by Olivia Owner/).waitFor();
  await list.locator('li').nth(3).locator('.pill.warn').waitFor();
  await sec.scrollIntoViewIfNeeded();
  await kim.screenshot({ path: `${SP}/shots/security-activity.png` });
  await axe(kim, 'security activity');
});

await step('“Change your password” takes her to the password form', async () => {
  const sec = kim.getByRole('region', { name: 'Recent security activity' });
  await sec.getByRole('button', { name: 'Change your password' }).click();
  await until(async () => kim.evaluate(() => document.activeElement?.id === 'password-h'));
  await kim.getByRole('form', { name: 'Change password' }).getByLabel('Current password').waitFor();
});

await step('Olivia’s list is her own: not Kim’s attempts, nor her signing Kim out', async () => {
  await page.goto(`${B}/settings`);
  const list = page.getByRole('region', { name: 'Recent security activity' });
  await list.getByText('You signed in').first().waitFor().catch(() => {});
  const text = await list.innerText();
  if (/tried|signed out/.test(text)) throw new Error(text);
  await list.getByRole('status').getByText(/last 30 days/).waitFor();
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
