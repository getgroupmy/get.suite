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
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (p, t) => p.locator('.chip', { hasText: t });
let kim, lee;
let launch, office, dm;
const side = (p) => p.locator('aside.subnav');
const starredList = (p) => side(p).getByRole('list', { name: 'Starred conversations' });
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  launch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  office = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
});
await step('star a channel and a direct message: they move to Starred at the top', async () => {
  await page.goto(`${B}/chat/${office}`);
  await page.getByRole('button', { name: 'Star conversation' }).click();
  await page.getByText('Starred: it’s at the top of your list').waitFor();
  await starredList(page).getByText('office').waitFor();
  await side(page).getByRole('button', { name: /Kim Park/ }).click();
  await page.getByRole('button', { name: 'Star conversation' }).click();
  await starredList(page).getByText('Kim Park').waitFor();
  const order = (await starredList(page).getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  if (!/office/.test(order[0]) || !/Kim Park/.test(order[1])) throw new Error(order.join('|'));
  // Not listed twice.
  if (await side(page).getByRole('button', { name: /^#\s*office/ }).count() !== 1) throw new Error('office listed twice');
  await page.screenshot({ path: `${SP}/shots/chatstar.png` });
});
await step('Kim’s list isn’t changed; unstarring puts it back', async () => {
  await kim.goto(`${B}/chat/${launch}`);
  await side(kim).getByText('office').waitFor();
  if (await starredList(kim).count()) throw new Error('Kim has starred ones');
  await page.goto(`${B}/chat/${office}`);
  await page.getByRole('button', { name: 'Unstar conversation' }).click();
  await until(async () => !(await starredList(page).getByText('office').count()));
  await side(page).getByRole('button', { name: /office/ }).waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
