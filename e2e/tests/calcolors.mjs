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
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let dm;
const colourOf = (title) => page.locator('[style*="--c"]', { hasText: title }).first().evaluate((el) => getComputedStyle(el).getPropertyValue('--c').trim());
await step('events with no colour of their own take a rule\'s colour, from Calendar settings', async () => {
  const at = new Date(); at.setHours(10, 0, 0, 0);
  for (const [title, color, h] of [['Kim 1:1', '#1a73e8', 0], ['Board 1:1', '#d50000', 2], ['Budget review', '#1a73e8', 4]]) {
    const r = await api(page, 'POST', '/events', { title, start: at.getTime() + h * 36e5, end: at.getTime() + (h + 1) * 36e5, color, all_day: 0 });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
  }
  await page.goto(`${B}/calendar`);
  await page.getByText('Kim 1:1').first().waitFor();
  if ((await colourOf('Kim 1:1')).toLowerCase() !== '#1a73e8') throw new Error(await colourOf('Kim 1:1'));
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Calendar settings' });
  await dlg.getByLabel('Word in the title').fill('1:1');
  await dlg.getByLabel('Colour for it').selectOption('#8e24aa');
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByText('“1:1”').waitFor();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Calendar settings saved').waitFor();
  await until(async () => (await colourOf('Kim 1:1')).toLowerCase() === '#8e24aa');
  if ((await colourOf('Board 1:1')).toLowerCase() !== '#d50000') throw new Error('its own colour should win');
  if ((await colourOf('Budget review')).toLowerCase() !== '#1a73e8') throw new Error('no rule: the usual');
  await page.screenshot({ path: `${SP}/shots/cal-colours.png` });
});
await step('nothing is saved on the events; kept after reloading; the rule can be removed', async () => {
  const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 864e5}`)).body;
  if (evs.find((e) => e.title === 'Kim 1:1').color !== '#1a73e8') throw new Error('the event itself changed');
  await page.reload();
  await page.getByText('Kim 1:1').first().waitFor();
  await until(async () => (await colourOf('Kim 1:1')).toLowerCase() === '#8e24aa');
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Calendar settings' });
  await dlg.getByRole('button', { name: 'Remove the rule for “1:1”' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await colourOf('Kim 1:1')).toLowerCase() === '#1a73e8');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
