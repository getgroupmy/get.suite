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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

await step('two messages close together: the sidebar ends up with both counted, whatever order its reloads answer in', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  const meId = (await api(page, 'GET', '/auth/me')).body.user.id;
  const dm = (await api(kim, 'POST', '/chat/dm', { user_id: meId })).body.id;
  void kimId;
  const gen = ((await api(page, 'GET', '/chat/channels')).body.channels || []).find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${gen}`);
  await page.getByRole('heading', { name: /general/ }).first().waitFor();
  await page.waitForTimeout(800);
  const p = (await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'a question' })).body.id;
  const row = page.getByRole('button', { name: /Kim Park/ });
  await row.locator('.badge', { hasText: /^1$/ }).waitFor();
  // A reply in its thread makes the list reload; that answer comes late, after the next message.
  let held = 0;
  await page.route((u) => u.pathname === '/api/chat/channels', async (route) => {
    if (held++ === 0) { const r = await route.fetch(); await new Promise((x) => setTimeout(x, 1500)); return route.fulfill({ response: r }); }
    return route.continue();
  });
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'more on it', parent_id: p });
  await page.waitForTimeout(500);
  await api(kim, 'POST', `/chat/channels/${dm}/messages`, { body: 'and another thing' });
  await page.waitForTimeout(3000);
  const badge = (await row.locator('.badge').innerText().catch(() => '')).trim();
  if (badge !== '2') throw new Error(`Kim's row shows “${badge}” after two messages`);
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
