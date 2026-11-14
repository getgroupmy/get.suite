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
const focused = () => page.evaluate(() => document.activeElement?.closest?.('tr[data-contact]')?.getAttribute('aria-label') || document.activeElement?.tagName);
const mine = async () => (await api(page, 'GET', '/contacts')).body;
const listOf = (b) => (Array.isArray(b) ? b : b.contacts || []);
let names;
await step('J / K move between contacts; Enter opens one', async () => {
  for (const n of ['Ada Byron', 'Ben Carter', 'Cleo Dunn']) await api(page, 'POST', '/contacts', { name: n, email: `${n.split(' ')[0].toLowerCase()}@example.com` });
  await page.goto(`${B}/contacts`);
  await page.locator('tr[data-contact]').nth(2).waitFor();
  names = await page.locator('tr[data-contact]').evaluateAll((l) => l.map((r) => r.getAttribute('aria-label')));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('j');
  await until(async () => (await focused()) === names[0]);
  await page.keyboard.press('j');
  await until(async () => (await focused()) === names[1]);
  await page.keyboard.press('k');
  await until(async () => (await focused()) === names[0]);
  await page.screenshot({ path: `${SP}/shots/contact-keys.png` });
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Edit contact' }).waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await page.getByRole('dialog').count()));
});
await step('S stars; # asks, then deletes', async () => {
  await page.locator(`tr[data-contact][aria-label="Ben Carter"]`).focus();
  await page.keyboard.press('s');
  await until(async () => listOf(await mine()).find((c) => c.name === 'Ben Carter')?.starred);
  await page.locator(`tr[data-contact][aria-label="Cleo Dunn"]`).focus();
  await page.keyboard.press('Shift+#');
  const dlg = page.getByRole('dialog', { name: 'Delete contact?' });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: /^Delete/ }).click();
  await until(async () => !listOf(await mine()).some((c) => c.name === 'Cleo Dunn'));
});
await step('C makes a new contact; the list shows Contacts keys; off, J does nothing', async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('c');
  await page.getByRole('dialog', { name: 'New contact' }).waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await page.getByRole('dialog').count()));
  await page.keyboard.press('Control+/');
  await page.getByRole('dialog').getByText('Next or previous person').waitFor();
  await axe(page, 'shortcut list');
  await page.keyboard.press('Escape');
  await axe(page, 'contacts with a focused row');
  await api(page, 'PUT', '/users/me/keys', { on: false });
  await page.reload();
  await page.locator('tr[data-contact]').first().waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('j');
  await page.waitForTimeout(400);
  if ((await focused()) !== 'BODY') throw new Error(`moved to ${await focused()}`);
  await api(page, 'PUT', '/users/me/keys', { on: true });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
