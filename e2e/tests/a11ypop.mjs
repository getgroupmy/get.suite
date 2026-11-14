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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async (label) => {
  await page.waitForTimeout(300);
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 140)}`));
  if (res.length) throw new Error(`${label}: ${res.join(' | ')}`);
};
const both = async (label) => { await scan(`${label} light`); await page.emulateMedia({ colorScheme: 'dark' }); await scan(`${label} dark`); await page.emulateMedia({ colorScheme: 'light' }); };
let general, top;
await step('people, rooms, a message', async () => {
  for (const [local, name] of [['kim', 'Kim Park']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  await api(page, 'POST', '/rooms', { name: 'Boardroom', capacity: 8 });
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  top = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Planning the offsite' })).body;
});
await step('Chat: the / command list (main box and a thread)', async () => {
  await page.goto(`${B}/chat/${general}`);
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('/');
  await page.getByRole('listbox', { name: 'Commands' }).waitFor();
  await both('commands');
  await box.fill('');
  const m = page.locator(`[data-mid="${top.id}"]`);
  await m.hover();
  await m.getByRole('button', { name: 'Reply in thread' }).click();
  const reply = page.getByRole('complementary', { name: 'Thread' }).getByLabel('Reply', { exact: true });
  await reply.fill('/');
  await page.getByRole('complementary', { name: 'Thread' }).getByRole('listbox', { name: 'Commands' }).waitFor();
  await both('thread commands');
  await reply.fill('');
});
await step('Calendar: quick add with its preview, and the event window it opens (guest and room chosen)', async () => {
  await page.goto(`${B}/calendar`);
  const q = page.getByLabel('Quick add an event');
  await q.fill('Budget review with @kim in the Boardroom tomorrow 2pm');
  await page.locator('#cal-quick-what').getByText(/in Boardroom$/).waitFor();
  await both('quick add');
  await q.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByRole('list', { name: 'Rooms' }).waitFor();
  await dlg.getByRole('list', { name: 'Invited guests' }).getByText('Kim Park').waitFor();
  await both('event window');
  await page.screenshot({ path: `${SP}/shots/a11y-event-window.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
