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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
let doc;
const body = () => page.locator('.ProseMirror');
const pop = () => page.getByRole('listbox', { name: 'Emoji' });
await step('typing ":" and a word offers emoji under the cursor; Enter puts the first in place of what was typed', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Team notes' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await body().click();
  await page.keyboard.type('Great job :thu');
  await pop().getByRole('option', { name: 'thumbs up' }).waitFor();
  await axe(page, 'emoji list');
  await page.screenshot({ path: `${SP}/shots/doc-emoji.png` });
  const first = (await pop().getByRole('option').first().innerText()).trim().split(/\s/)[0];
  await page.keyboard.press('Enter');
  await until(async () => (await body().innerText()).includes(`Great job ${first}`) && !(await body().innerText()).includes(':thu'));
  if (await pop().count()) throw new Error('list stayed');
});
await step('arrows choose another, Escape closes it; times and "Note: x" offer nothing', async () => {
  await page.keyboard.type(' :party');
  await pop().waitFor();
  await page.keyboard.press('Escape');
  if (await pop().count()) throw new Error('Escape did not close');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Meet at 10:30. Note: bring the slides');
  await page.waitForTimeout(300);
  if (await pop().count()) throw new Error('offered for a time or a note');
  await page.keyboard.press('Enter');
  await page.keyboard.type(':heart');
  await pop().waitFor();
  const second = (await pop().getByRole('option').nth(1).innerText()).trim().split(/\s/)[0];
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await until(async () => (await body().innerText()).includes(second));
});
await step('the toolbar emoji button: search and pick, at the cursor', async () => {
  await page.keyboard.type(' and ');
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  await page.getByLabel('Search emoji').fill('thu up');
  await page.keyboard.press('Enter');
  await page.keyboard.type('!');
  await until(async () => (await body().innerText()).includes(' and 👍!'));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
