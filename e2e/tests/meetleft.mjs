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
await step('a meeting with a kept chat; Max leaves after a few seconds', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Retro' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: /^People/ }).click();
  await page.getByLabel('Keep the meeting chat').check();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await max.getByRole('button', { name: /^Chat/ }).click();
  await max.getByLabel('Send a message to everyone').fill('Went well');
  await max.getByRole('button', { name: 'Send' }).click();
  await max.waitForTimeout(2500);
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
}, max);
await step('after leaving: how long, Who joined (2), Meeting chat (1); both open', async () => {
  await max.getByRole('heading', { name: 'You left the meeting' }).waitFor();
  const t = await max.getByText(/^You were in it for /).innerText();
  if (!/for 0:0[2-9]\.$|for 0:\d\d\.$/.test(t)) throw new Error(t);
  await max.getByRole('button', { name: '👥 Who joined (2)' }).click();
  await max.getByRole('dialog', { name: 'Who joined Retro' }).getByText('Olivia Owner').waitFor();
  await max.getByRole('dialog', { name: 'Who joined Retro' }).getByRole('button', { name: 'Done' }).click();
  await max.getByRole('button', { name: '💬 Meeting chat (1)' }).click();
  await max.getByRole('dialog', { name: 'Chat from Retro' }).getByText('Went well').waitFor();
  await max.getByRole('dialog', { name: 'Chat from Retro' }).getByRole('button', { name: 'Done' }).click();
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  await max.addScriptTag({ content: AXE });
  const res = await max.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 150)}`));
  if (res.length) throw new Error(res.join(' | '));
}, max);
await step('Rejoin still works', async () => {
  await max.getByRole('button', { name: 'Rejoin' }).click();
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
}, max);
await step('removed by the host: no Rejoin, but the time, who joined and the chat', async () => {
  await max.waitForTimeout(1500);
  if (!(await page.getByRole('button', { name: 'Remove Max Meet from the meeting' }).count())) await page.getByRole('button', { name: /^People/ }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Remove Max Meet from the meeting' }).click();
  await max.getByRole('heading', { name: 'You were removed from the meeting' }).waitFor();
  if (await max.getByRole('button', { name: 'Rejoin' }).count()) throw new Error('rejoin offered');
  await max.getByText(/^You were in it for /).waitFor();
  await max.getByRole('button', { name: /^👥 Who joined \(\d+\)$/ }).waitFor();
  await max.getByRole('button', { name: '💬 Meeting chat (1)' }).waitFor();
}, max);
await step('the host ends it: their screen too', async () => {
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'End the meeting for everyone' }).click();
  await page.getByRole('heading', { name: 'The meeting has ended' }).waitFor();
  await page.getByText(/^You were in it for /).waitFor();
  await page.getByRole('button', { name: '💬 Meeting chat (1)' }).click();
  await page.getByRole('dialog', { name: 'Chat from Retro' }).getByText('Went well').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
