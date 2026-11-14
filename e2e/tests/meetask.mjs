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
const max = await mk('max');
let code;
await step('Olivia in a meeting; Max elsewhere in Workspace', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Sync' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/drive`);
  await max.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await max.waitForTimeout(1000);
});
const ring = async () => {
  const box = page.getByLabel('Ask someone to join');
  if (!(await box.count())) await page.getByRole('button', { name: 'People', exact: true }).click();
  await box.fill('Max Meet (max@acme.com)');
  await page.getByRole('button', { name: '📞 Ring' }).click();
  await page.getByText('Ringing Max Meet…').waitFor();
};
await step('People → Ask someone to join → Ring: Max is asked; Can’t talk tells Olivia', async () => {
  await ring();
  await max.getByText('📞 Olivia Owner is asking you to join “Sync”').waitFor();
  await max.getByRole('button', { name: 'Can’t talk' }).click();
  await page.getByText('Max Meet can’t talk right now').waitFor();
});
await step('rung again, Max picks Join: the meeting opens for him, and they see each other', async () => {
  await ring();
  await max.getByText('📞 Olivia Owner is asking you to join “Sync”').waitFor();
  const [tab] = await Promise.all([max.context().waitForEvent('page'), max.getByRole('button', { name: 'Join', exact: true }).click()]);
  await tab.waitForURL(`**/meet/${code}`);
  await tab.getByRole('button', { name: 'Join now' }).click();
  await tab.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.locator('.meet-tile', { hasText: 'Max Meet' }).first().waitFor();
});
await step('someone already in it is not offered', async () => {
  const opts = await page.locator('#meet-ask-people option').evaluateAll((os) => os.map((o) => o.value));
  if (opts.some((v) => v.startsWith('Max Meet'))) throw new Error(opts.join('|'));
});
const kim = await mk('kim');
await step('on a calendar event: Ring everyone invited who isn’t here (Kim); the button goes once she’s in', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const start = Date.now();
  await api(page, 'POST', '/events', { title: 'Sync', start, end: start + 3600e3, meet_code: code, guests: ['max@acme.com', 'kim@acme.com'] });
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.waitForTimeout(800);
  await page.getByRole('button', { name: 'People', exact: true }).click(); // close
  await page.getByRole('button', { name: 'People', exact: true }).click(); // and open again: looks afresh
  const all = page.getByRole('button', { name: /^📞 Ring everyone invited who isn’t here \((\d+)\)$/ });
  await all.waitFor();
  if (!/\(1\)$/.test(await all.innerText()) || (await all.getAttribute('title')) !== 'Kim Park') throw new Error(`${await all.innerText()} / ${await all.getAttribute('title')}`);
  await all.click();
  await page.getByText('Ringing Kim Park…').waitFor();
  await kim.getByText('📞 Olivia Owner is asking you to join “Sync”').waitFor();
  const [tab] = await Promise.all([kim.context().waitForEvent('page'), kim.getByRole('button', { name: 'Join', exact: true }).click()]);
  await tab.getByRole('button', { name: 'Join now' }).click();
  await tab.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await until(async () => !(await all.count()), 10000);
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
