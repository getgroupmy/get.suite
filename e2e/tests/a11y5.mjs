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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const all = [];
const scan = async (name, p = page) => {
  await p.waitForTimeout(600);
  await p.addScriptTag({ content: AXE });
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
  for (const v of res) all.push({ page: name, ...v });
  if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
};
let code;
await step('Meet lobby with Camera, Microphone, Speaker, the level meter and Test speaker', async () => {
  code = (await api(page, 'POST', '/meet', { title: 'A11y' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('meter', { name: 'Microphone level' }).waitFor();
  await page.getByLabel('Speaker', { exact: true }).waitFor();
  await scan('meet lobby with devices');
});
await step('Meet ⚙ Audio and video panel in the meeting', async () => {
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  await page.getByRole('complementary', { name: 'Audio and video settings' }).getByLabel('Camera', { exact: true }).waitFor();
  await scan('meet devices panel');
});
await step('Meet People panel (host settings, breakouts)', async () => {
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByRole('complementary', { name: 'People' }).getByLabel('Keep the meeting chat').waitFor();
  await scan('meet people panel');
});
await step('Meet chat with a message and a keep-chat note', async () => {
  await page.getByLabel('Keep the meeting chat').check();
  await page.getByRole('button', { name: /^Chat/ }).click();
  const c = page.getByRole('complementary', { name: 'Meeting chat' });
  await c.getByLabel('Send a message to everyone').fill('Hello all');
  await c.getByRole('button', { name: 'Send' }).click();
  await c.getByText('Hello all').waitFor();
  await scan('meet chat panel');
});
await step('Meet polls and Q&A', async () => {
  await page.getByRole('button', { name: /^Polls/ }).click();
  await page.getByRole('complementary', { name: 'Polls' }).waitFor();
  await scan('meet polls panel');
  await page.getByRole('button', { name: /^Questions/ }).click();
  await page.getByRole('complementary', { name: 'Questions' }).waitFor();
  await scan('meet questions panel');
});
await step('Meet whiteboard', async () => {
  await page.getByRole('button', { name: /^Whiteboard/ }).click();
  await page.waitForTimeout(500);
  await scan('meet whiteboard');
});
const gina = await mk('gina');
await step('a guest without an account: the ask-to-join page and the waiting screen', async () => {
  await gina.goto(`${B}/meet/${code}`);
  await gina.getByLabel('Your name').fill('Gina Client');
  await scan('meet guest lobby', gina);
  await gina.getByRole('button', { name: 'Ask to join' }).click();
  await gina.getByRole('heading', { name: 'Asking to join…' }).waitFor();
  await scan('meet guest waiting', gina);
}, gina);
await step('the host sees who is waiting to join', async () => {
  await page.getByRole('region', { name: 'Waiting to join' }).getByText('Gina Client').waitFor();
  await scan('meet waiting to join banner');
  await page.getByRole('button', { name: 'Let Gina Client in', exact: true }).click();
  await gina.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
const max = await mk('max');
await step('breakout rooms open: the host view and a room', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  if (!(await page.getByLabel('Number of rooms').count())) await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.getByLabel('Number of rooms').selectOption('2');
  await page.getByRole('button', { name: 'Open rooms' }).click();
  await max.getByText(/You’re in breakout Room \d/).waitFor();
  await page.getByLabel('Room 1', { exact: true }).waitFor();
  await scan('meet breakouts open (host)');
  await scan('meet in a breakout room', max);
});
for (const v of all) console.log("V", v.page, "|", v.where, "|", v.html);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
