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
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
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
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label, p = page) => {
  await p.waitForTimeout(300);
  await p.evaluate(AXE);
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label, p = page) => { await p.emulateMedia({ colorScheme: 'light' }); await scan(`${label} light`, p); await p.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`, p); await p.emulateMedia({ colorScheme: 'light' }); };
const signInHere = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Drive' }).waitFor();
};
let ch;
await step('the channel’s maker writes a welcome note in its settings; they don’t get it themselves', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'design-crit' })).body;
  await page.goto(`${B}/chat/${ch.id}`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  await page.getByRole('dialog', { name: '#design-crit' }).getByLabel(/Welcome note/).fill('Post work in progress in a thread.\nBe kind and specific.');
  await page.getByRole('dialog', { name: '#design-crit' }).getByLabel(/Welcome note/).locator('xpath=ancestor::div[contains(@class,"stack")][1]').getByRole('button', { name: 'Save' }).click();
  await page.getByText('Welcome note saved: people who join from now on see it').waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('heading', { name: /design-crit/ }).first().waitFor().catch(() => {});
  await page.waitForTimeout(800);
  if (await page.getByRole('region', { name: 'Welcome to #design-crit' }).count()) throw new Error('shown to its maker');
});
await step('someone new sees the note until “Got it”', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const k = await mk('kim');
  await signInHere(k, 'kim@acme.com');
  await k.goto(`${B}/chat/${ch.id}`);
  const note = k.getByRole('region', { name: 'Welcome to #design-crit' });
  await note.getByText('Be kind and specific.').waitFor({ timeout: 10000 });
  await k.screenshot({ path: `${SP}/shots/welcome.png` });
  await both('chat welcome note', k);
  await note.getByRole('button', { name: 'Got it' }).click();
  await until(async () => (await note.count()) === 0);
  await k.reload();
  await k.waitForTimeout(1500);
  if (await k.getByRole('region', { name: 'Welcome to #design-crit' }).count()) throw new Error('back after Got it');
}, page);
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
