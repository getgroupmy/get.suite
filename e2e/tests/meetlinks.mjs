import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
const gus = await mk('gus');
let evId, code;
const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
await step('event with a guest', async () => {
  await api(page, 'POST', '/users', { local: 'gus', domain: 'acme.com', name: 'Gus Guest', password: 'password123' });
  const start = dayStart + 22 * 36e5;
  const r = await api(page, 'POST', '/events', { title: 'Planning', start, end: start + 36e5, guests: ['gus@acme.com'] });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  evId = r.body.id;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.locator('.month .chip', { hasText: 'Planning' }).first().click();
});
await step('organizer adds a video meeting and saves', async () => {
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByRole('button', { name: 'Add video meeting' }).click();
  await d.getByRole('group', { name: 'Video meeting' }).getByRole('link', { name: 'Join video meeting' }).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => { const ev = (await api(page, 'GET', `/events?from=${dayStart}&to=${dayStart + 2 * 864e5}`)).body.find((e) => e.id === evId); code = ev?.meet_code; return !!code; });
});
await step('guest sees Join in the invitation, which opens the meeting', async () => {
  await signIn(gus, 'gus@acme.com');
  await gus.goto(`${B}/calendar`);
  await gus.getByRole('radio', { name: 'Month' }).click();
  await gus.locator('.month .chip', { hasText: 'Planning' }).first().click();
  const link = gus.getByRole('dialog', { name: 'Planning' }).getByRole('link', { name: 'Join video meeting' });
  if ((await link.getAttribute('href')) !== `/meet/${code}`) throw new Error(await link.getAttribute('href'));
  const [tab] = await Promise.all([gus.context().waitForEvent('page'), link.click()]);
  await tab.getByRole('heading', { name: 'Planning' }).waitFor();
  await tab.getByRole('button', { name: 'Join now' }).waitFor();
  await tab.close();
});
await step('organizer removes the meeting', async () => {
  await page.locator('.month .chip', { hasText: 'Planning' }).first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByRole('group', { name: 'Video meeting' }).getByRole('button', { name: 'Remove' }).click();
  await d.getByRole('button', { name: 'Add video meeting' }).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => (await api(page, 'GET', `/events?from=${dayStart}&to=${dayStart + 2 * 864e5}`)).body.find((e) => e.id === evId).meet_code === null);
});
await step('chat: start a meeting posts a Join card for everyone', async () => {
  await page.goto(`${B}/chat`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'Start a video meeting' }).click()]);
  await tab.getByRole('button', { name: 'Join now' }).waitFor();
  await tab.close();
  await page.getByText('Started a video meeting').waitFor();
  await gus.goto(`${B}/chat`);
  await gus.getByText('Started a video meeting').waitFor();
  const join = gus.getByRole('link', { name: 'Join video meeting' }).last();
  if (!/^\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(await join.getAttribute('href'))) throw new Error('href');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
