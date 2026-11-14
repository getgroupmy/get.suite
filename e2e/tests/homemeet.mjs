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
const kim = await mk('kim');
let code;
await step('Olivia and Max meet; the chat is kept', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Design sync' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: /^People/ }).click();
  await page.getByLabel('Keep the meeting chat').check();
  await page.getByRole('button', { name: /^Chat/ }).click();
  await page.getByLabel('Send a message to everyone').fill('Agreed: blue');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(500);
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
});
await step('while Olivia is still in it, Max’s Home says so; Join opens the meeting', async () => {
  await max.goto(`${B}/home`);
  const card = max.getByRole('region', { name: 'Recent video meetings' });
  await card.getByText('Design sync').waitFor();
  await card.getByText('● 1 in it').waitFor();
  if (await card.getByRole('link', { name: 'Join Design sync' }).getAttribute('href') !== `/meet/${code}`) throw new Error('join link');
}, max);
await step('after it: 💬 opens the kept chat, 👥 who joined', async () => {
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
  await max.reload();
  const card = max.getByRole('region', { name: 'Recent video meetings' });
  await card.getByRole('button', { name: 'Chat from Design sync' }).click();
  const d = max.getByRole('dialog', { name: 'Chat from Design sync' });
  await d.getByText('Agreed: blue').waitFor();
  await d.getByRole('button', { name: 'Done' }).click();
  await card.getByRole('button', { name: 'Who joined Design sync' }).click();
  await max.getByRole('dialog', { name: 'Who joined Design sync' }).getByRole('table', { name: 'Attendance' }).getByText('Olivia Owner').waitFor();
  await max.getByRole('dialog', { name: 'Who joined Design sync' }).getByRole('button', { name: 'Done' }).click();
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  await max.addScriptTag({ content: AXE });
  const res = await max.evaluate(async () => (await window.axe.run(document.querySelector('[aria-label="Recent video meetings"]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 150)}`));
  if (res.length) throw new Error(res.join(' | '));
}, max);
await step('Customize lists the card; someone with no meetings has none', async () => {
  await max.getByRole('button', { name: 'Customize' }).click();
  await max.getByText('Recent video meetings').last().waitFor();
  await max.keyboard.press('Escape');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/home`);
  await kim.getByRole('heading', { level: 1 }).first().waitFor();
  await kim.waitForTimeout(1500);
  if (await kim.getByRole('region', { name: 'Recent video meetings' }).count()) throw new Error('kim has a card');
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
